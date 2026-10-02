// tests/previewIndexWriterOff.test.js — D-1 PR-D · Task E.1 (+ E.3 negative control)
//
// The preview-index writer capability is served by the server (/api/vault/tree/state flags.previewIndexWriteEnabled,
// env VAULT_PREVIEW_INDEX_WRITE_ENABLED, default false). When it is not exactly `true` the writer is inert: offer()
// answers 'DISABLED', nothing is queued, and not a single request leaves the client.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPreviewIndexWriter, previewIndexWriteAllowed, WRITER_OFFER } from '../src/lib/vaultPreviewIndexWriter.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { fakeJpeg, newKek, id22 } from './helpers/previewIndexFixture.mjs'

const src = readFileSync(new URL('../src/lib/vaultPreviewIndexWriter.js', import.meta.url), 'utf8')

function spyEverything() {
  const calls = []
  const rec = (name) => async (...args) => { calls.push(name); throw new Error(`unexpected ${name}(${args.length})`) }
  const api = { getPreviewIndexHead: rec('getPreviewIndexHead'), getPreviewIndexEnvelopes: rec('getPreviewIndexEnvelopes'), casPreviewIndexHead: rec('casPreviewIndexHead') }
  const transport = { fetchJson: rec('fetchJson'), sendUpload: rec('sendUpload'), fetchBytes: rec('fetchBytes') }
  const reader = { load: rec('reader.load'), snapshot: () => { calls.push('reader.snapshot'); return { head: null, root: null } }, shardOf: rec('reader.shardOf'), clear() {} }
  return { calls, api, transport, reader, upload: rec('upload'), getMainHead: rec('getMainHead') }
}

const job = () => ({ nodeId: id22(), kind: 'thumb', sourceBlobRef: { formatVersion: 2, id: 'a'.repeat(48) }, bytes: fakeJpeg(320, 240), mime: 'image/jpeg', width: 320, height: 240 })

test('PIW-OFF-1 writeAllowed derives only from treeState.flags.previewIndexWriteEnabled === true', () => {
  assert.equal(previewIndexWriteAllowed({ flags: { previewIndexWriteEnabled: true } }), true)
  for (const v of [false, 'true', 1, null, undefined, {}, [true]]) assert.equal(previewIndexWriteAllowed({ flags: { previewIndexWriteEnabled: v } }), false, String(v))
  assert.equal(previewIndexWriteAllowed({ flags: {} }), false)
  assert.equal(previewIndexWriteAllowed(null), false)
  assert.equal(previewIndexWriteAllowed(undefined), false)
  // a read flag, the media flag, or a role never implies the writer
  assert.equal(previewIndexWriteAllowed({ flags: { previewIndexReadEnabled: true, mediaPreviewEnabled: true }, role: 'admin' }), false)
})

test('PIW-OFF-2 writer OFF: offer() → DISABLED, nothing queued, zero network calls; flush() → zeros with zero calls', async () => {
  const s = spyEverything()
  const unlockedState = createUnlockedVaultState({ closeAllPreviewSessions: () => {} })
  const w = createPreviewIndexWriter({ kek: await newKek(), api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload, unlockedState, writeAllowed: () => false })
  for (let i = 0; i < 5; i++) assert.equal(w.offer(job()), WRITER_OFFER.DISABLED)
  assert.equal(w.stats().queued, 0)
  const r = await w.flush()
  assert.deepEqual(r, { committed: 0, dropped: 0, failed: 0, budgetExhausted: false })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(s.calls, [], 'no request, no reader use, no main-head read')
})

test('PIW-OFF-3 writeAllowed is evaluated on every offer (no cached enablement) and the writer has no client toggle', async () => {
  const s = spyEverything()
  let allowed = false
  const w = createPreviewIndexWriter({ kek: await newKek(), api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload, writeAllowed: () => allowed, autoFlush: false })
  assert.equal(w.offer(job()), WRITER_OFFER.DISABLED)
  allowed = true
  assert.equal(w.offer(job()), WRITER_OFFER.QUEUED, 'only the injected server-served predicate decides')
  allowed = false
  assert.deepEqual(await w.flush(), { committed: 0, dropped: 0, failed: 0, budgetExhausted: false }, 'a flag turned off before flush sends nothing')
  assert.deepEqual(s.calls, [])
  assert.deepEqual(Object.keys(w).sort(), ['dispose', 'flush', 'offer', 'stats'], 'no enable/disable/setFlag method exists')
})

test('PIW-OFF-4 missing or throwing writeAllowed fails closed', async () => {
  const s = spyEverything()
  const kek = await newKek()
  const a = createPreviewIndexWriter({ kek, api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload })
  assert.equal(a.offer(job()), WRITER_OFFER.DISABLED)
  const b = createPreviewIndexWriter({ kek, api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload, writeAllowed: () => { throw new Error('x') } })
  assert.equal(b.offer(job()), WRITER_OFFER.DISABLED)
  assert.deepEqual(s.calls, [])
})

test('PIW-OFF-5 source: capability never comes from storage, URL, build constants or the manifest-v2 upgrade flag', () => {
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'location', 'URLSearchParams', 'import.meta.env', 'process.env', 'VAULT_MANIFEST_V2_UPGRADE', 'manifestV2Upgrade', 'console.']) {
    assert.equal(src.includes(banned), false, banned)
  }
})
