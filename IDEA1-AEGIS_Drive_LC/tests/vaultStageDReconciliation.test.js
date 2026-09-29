import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function optionalModule(specifier) {
  try { return await import(specifier) } catch { return null }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('PVUX-5 deterministic post-upload reconciliation awaits both TREE head and opaque blob inventory', async () => {
  const mod = await optionalModule('../src/lib/vaultPostUploadReconcile.js')
  assert.equal(typeof mod?.reconcileVaultAfterUpload, 'function', 'a scoped deterministic reconciliation helper exists')

  const head = deferred()
  const inventory = deferred()
  const calls = []
  let ready = false
  const work = mod.reconcileVaultAfterUpload({
    reloadHead: async () => { calls.push('head'); await head.promise },
    reloadInventory: async () => { calls.push('inventory'); await inventory.promise },
    onReconciled: () => { ready = true },
  })

  await Promise.resolve()
  assert.deepEqual(new Set(calls), new Set(['head', 'inventory']), 'both authoritative facts start without arbitrary sleeps')
  head.resolve()
  await Promise.resolve()
  assert.equal(ready, false, 'preview eligibility is not announced before inventory reconciliation')
  inventory.resolve()
  await work
  assert.equal(ready, true, 'the scheduler-facing completion happens only after both facts reconcile')
})

test('PVUX-10 large RANGE_V2 video poster cost is bounded by the existing preview cache, not full plaintext size', async () => {
  const mod = await optionalModule('../src/lib/vaultVideoPreview.js')
  assert.equal(typeof mod?.videoPosterEstimateBytes, 'function', 'video poster scheduling exposes its bounded cost contract')
  const onePointOneGiB = Math.floor(1.1 * 1024 ** 3)
  const estimate = mod.videoPosterEstimateBytes({ variant: 2, supportsLarge: true, plainSize: onePointOneGiB })
  assert.ok(estimate < onePointOneGiB, 'RANGE_V2 does not reserve memory proportional to the complete video')
  assert.ok(estimate <= 64 * 1024 * 1024, 'estimate stays within the existing measured worker plaintext cache')
  assert.equal(
    mod.videoPosterEstimateBytes({ variant: 1, supportsLarge: false, plainSize: 12_345 }),
    12_345,
    'whole-file fallback keeps the real source-size estimate',
  )
})

test('PVUX-15 global App search is absent on the Private Vault route while local Vault search remains', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8')
  const screen = fs.readFileSync(path.join(root, 'src/screens/VaultTreeScreen.jsx'), 'utf8')
  assert.match(app, /HEADER_SEARCH_HIDDEN_SCREENS\s*=\s*new Set\(\[[^\]]*['"]vault['"]/, 'Vault belongs to the hidden global-search set')
  assert.match(screen, /data-testid=["']vault-workspace-search["']/, 'the unlocked client-only Vault search remains present')
})

test('PVUX-5..8 source forbids reload races and wires awaited reconciliation before preview scheduling', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const screen = fs.readFileSync(path.join(root, 'src/screens/VaultTreeScreen.jsx'), 'utf8')
  const uploadStart = screen.indexOf('const runVaultUpload')
  const uploadEnd = screen.indexOf('/* ── ดาวน์โหลด', uploadStart)
  const uploadSection = screen.slice(uploadStart, uploadEnd)
  assert.doesNotMatch(uploadSection, /window\.location\.reload|location\.reload|setTimeout\s*\(/, 'Vault upload reconciliation uses no page reload or timing workaround')
  assert.match(screen, /await\s+reconcileVaultAfterUpload\s*\(/, 'successful encrypted upload awaits the deterministic reconcile barrier')
  assert.match(screen, /scheduler\.observe\(/, 'image, GIF, and video cards continue through the shared scheduler after reconciliation')
})
