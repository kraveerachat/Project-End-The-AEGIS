// tests/vaultScreenHarnessStubs.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 11a
//
// The bulk ZIP modules live in src/lib and import './vaultChunkedDownload.js' (a './' specifier), unlike
// the screen ('../lib/vaultChunkedDownload.js'). The harness must map BOTH to the one fixture instance,
// otherwise the Vault screen suites would run the real envelope crypto against fake envelopes and fail
// for reasons unrelated to the screen under test.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import { CORRECT_PASSPHRASE, makeVaultBackend, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { startVaultScreenEnv } from './helpers/vaultScreenHarness.js'

let env
before(async () => { env = await startVaultScreenEnv() })
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__ })

test('HARNESS-1 the fixture exports authenticateVaultV2Entry and apiFetchStream', async () => {
  const fixture = await env.load('/tests/fixtures/vaultScreenBackend.js')
  assert.equal(typeof fixture.authenticateVaultV2Entry, 'function')
  assert.equal(typeof fixture.apiFetchStream, 'function')
})

test('HARNESS-2 bulkZipDownload.js resolves ./vaultChunkedDownload.js to the screen fixture instance', async () => {
  const backend = makeVaultBackend()
  backend.downloadEvents = []
  globalThis.__VAULT_BACKEND__ = backend
  const kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  const { createVaultV2EntrySource } = await env.load('/src/lib/bulkZipDownload.js')
  const blob = serverBlobV2({ id: 'Z'.padEnd(22, 'z'), name: 'x', plainSize: 4, chunkCount: 1, size: 20 })
  const plan = Object.freeze({ entries: Object.freeze([Object.freeze({ nodeId: 'n', name: 'x', size: 4, blob })]) })
  const pre = await createVaultV2EntrySource({ kek }).preflight(plan, new AbortController().signal)
  assert.deepEqual(backend.downloadEvents, ['auth'], 'the fixture authenticate ran, not the real WebCrypto one')
  assert.equal(pre.ok, true)
  assert.equal(pre.effectivePlan.entries[0].size, 4)
})
