// tests/vaultLegacyV2DownloadBusy.test.js — AEGIS Drive (IDEA1) · PR #334 Codex blocker 3
//
// Legacy (FLAT grid) Private Vault V2 download must be single-flight:
//   LV2-BUSY-1 a second Download click while the Save picker is open opens no second picker
//   LV2-BUSY-2 a second Download click while the V2 transfer runs opens no second picker and does not
//              replace the active Cancel target — Cancel still aborts the first destination
//   LV2-BUSY-3 the existing busy surface (disabled tile controls) is shown while a V2 download is
//              active, and Download works again once it ends
//
// The legacy grid is unreachable once unlocked in production (every unlocked experience returns earlier),
// so the harness opts into tests/fixtures/legacyGridConvergenceStub.js to reach the shipped code path.
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React from 'react'

import { makeT } from '../src/lib/strings.js'
import { makeVaultBackend, serverBlobV2, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import { startVaultScreenEnv, settle, click, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')

let env
let dom
let Vault

before(async () => {
  env = await startVaultScreenEnv({ legacyGridStub: true })
  ;({ dom, Vault } = env)
})
after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
  delete globalThis.showSaveFilePicker
})

let backend
beforeEach(() => {
  backend = makeVaultBackend()
  globalThis.__VAULT_BACKEND__ = backend
  delete globalThis.showSaveFilePicker
})

const doc = () => dom.window.document
const qa = (sel) => [...doc().querySelectorAll(sel)]
const ID = 'LG'.padEnd(22, 'G')

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await settle()
}

/** Picker whose answer the test releases; every call is recorded. */
function installGatedPicker() {
  const calls = []
  const writables = []
  let release
  globalThis.showSaveFilePicker = (opts) => {
    calls.push(opts)
    const writable = { closed: false, aborted: false }
    writables.push(writable)
    const handle = {
      createWritable: async () => ({
        async write() {},
        async close() { writable.closed = true },
        async abort() { writable.aborted = true },
      }),
    }
    if (calls.length === 1) return new Promise((r) => { release = () => r(handle) })
    return Promise.resolve(handle)
  }
  return { calls, writables, releasePicker: () => release?.() }
}

/** Open the tile menu and press Download if the controls allow it. Returns whether Download was pressed. */
async function tryDownload() {
  const menuBtn = doc().querySelector(`[data-vault-tile-menu="${ID}"]`)
  assert.ok(menuBtn, 'legacy tile menu button rendered')
  if (menuBtn.disabled) return false
  await click(dom, menuBtn)
  const item = qa('[role="menuitem"]').find((b) => b.textContent.trim() === t('download'))
  if (!item || item.disabled) return false
  await click(dom, item)
  return true
}

test('LV2-BUSY-1..3 legacy V2 download is single-flight: no second picker, Cancel keeps its target', async () => {
  backend.streamingSink = true
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlobV2({ id: ID, name: 'big.bin', type: 'application/octet-stream', plainSize: 64, chunkCount: 4, size: 128 })] },
    error: null,
  }
  let releaseTransfer
  let transfers = 0
  backend.downloadImpl = async ({ sink, signal }) => {
    transfers += 1
    await new Promise((r) => { releaseTransfer = r; signal?.addEventListener('abort', r) })
    if (signal?.aborted) { await sink.abort(); return { ok: false, reason: 'cancelled' } }
    await sink.write(new Uint8Array(64))
    await sink.close()
    return { ok: true, chunksRead: 4, bytesWritten: 64 }
  }
  const { calls, writables, releasePicker } = installGatedPicker()

  const h = env.mount()
  await h.render(React.createElement(Vault, { t }))
  try {
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await tick(6)
    assert.ok(doc().querySelector(`[data-vault-tile-menu="${ID}"]`), 'legacy grid tile is reachable through the stub')

    assert.equal(await tryDownload(), true)
    await tick(2)
    assert.equal(calls.length, 1, 'first click opened the picker')

    // LV2-BUSY-1: picker still open
    await tryDownload()
    await tick(2)
    assert.equal(calls.length, 1, 'no second picker while the first picker is open')

    releasePicker()
    await tick(4)
    assert.equal(transfers, 1, 'the first V2 transfer is running')

    // LV2-BUSY-2: transfer running
    await tryDownload()
    await tick(2)
    assert.equal(calls.length, 1, 'no second picker while the V2 transfer runs')
    assert.equal(transfers, 1, 'no second transfer started')

    // LV2-BUSY-3: existing busy surface — tile controls are disabled during the active download
    assert.equal(doc().querySelector(`[data-vault-tile-menu="${ID}"]`).disabled, true, 'tile controls show busy')

    const cancel = qa('button').find((b) => b.textContent.trim() === t('vaultXferCancel'))
    assert.ok(cancel, 'Cancel is offered for the active transfer')
    await click(dom, cancel)
    await tick(4)
    assert.equal(writables[0].aborted, true, 'Cancel aborted the FIRST destination (target not replaced)')
    assert.equal(writables[0].closed, false)

    // after the transfer ends the guard is released and Download works again
    assert.equal(await tryDownload(), true, 'Download available again after the transfer ended')
    await tick(4)
    assert.equal(calls.length, 2)
    releaseTransfer?.()
    await tick(4)
  } finally {
    releaseTransfer?.()
    await h.unmount()
  }
})
