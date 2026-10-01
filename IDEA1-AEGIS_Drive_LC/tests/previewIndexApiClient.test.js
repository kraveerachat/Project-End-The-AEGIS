// tests/previewIndexApiClient.test.js — AEGIS Drive (IDEA1) · D-1 PR-A Task A.5 · read-only preview-index client wrappers
//
// PIC-1 paths, signal forwarding, GET only, no body
// PIC-2 getPreviewIndexHead: 404 PREVIEW_INDEX_NOT_FOUND and 503 PREVIEW_INDEX_DISABLED → null (normal "no index"); other failures throw TreeApiError
// PIC-3 getPreviewIndexEnvelopes([]) makes no request; ids are URL-encoded as one comma list; no client-side batching or retry
// PIC-4 no write wrapper exists in PR-A; no browser storage is touched
import test from 'node:test'
import assert from 'node:assert/strict'
import * as treeApi from '../src/lib/vaultTreeApi.js'

const ok = (data = {}, status = 200) => ({ ok: true, status, data, errorKind: null })
const srvErr = (status, code) => ({ ok: false, status, data: { error: 'e', code }, errorKind: 'server' })
const net = () => ({ ok: false, status: 0, data: null, errorKind: 'network' })
function recorder(reply) {
  const calls = []
  return { calls, fetchJson: async (path, opts = {}) => { calls.push({ path, opts }); return reply } }
}
const SIGNAL = new AbortController().signal
const ID1 = 'a'.repeat(48), ID2 = 'b'.repeat(48)
const HEAD = { treeId: 'T'.repeat(22), indexGeneration: 2, rootBlobRef: { formatVersion: 2, id: ID1 }, rootContentIdB64: 'AAECAwQFBgcICQoLDA0ODw==' }

test('PIC-1 read wrappers call the documented GET paths with the caller signal and no body', async () => {
  const cases = [
    ['getPreviewIndexHead', [], '/api/vault/tree/preview-index/head', HEAD],
    ['getPreviewIndexEnvelopes', [[ID1, ID2]], `/api/vault/tree/preview-index/envelopes?ids=${ID1}%2C${ID2}`, { blobs: [] }],
    ['listPreviewIndexBlobs', [{}], '/api/vault/tree/preview-index/blobs', { blobs: [], next: null }],
    ['listPreviewIndexBlobs', [{ after: ID1, limit: 50 }], `/api/vault/tree/preview-index/blobs?limit=50&after=${ID1}`, { blobs: [], next: null }],
  ]
  for (const [fn, args, path, data] of cases) {
    const { fetchJson, calls } = recorder(ok(data))
    const out = await treeApi[fn](...args, { fetchJson, signal: SIGNAL })
    assert.equal(calls.length, 1, fn)
    assert.equal(calls[0].path, path, fn)
    assert.equal(calls[0].opts.method, 'GET', fn)
    assert.equal(calls[0].opts.body, undefined, fn)
    assert.equal(calls[0].opts.signal, SIGNAL, fn)
    assert.ok(out, fn)
  }
})

test('PIC-2 getPreviewIndexHead maps "no index" and "reader disabled" to null; everything else throws TreeApiError', async () => {
  assert.deepEqual(await treeApi.getPreviewIndexHead({ fetchJson: recorder(ok(HEAD)).fetchJson }), HEAD)
  assert.equal(await treeApi.getPreviewIndexHead({ fetchJson: recorder(srvErr(404, 'PREVIEW_INDEX_NOT_FOUND')).fetchJson }), null)
  assert.equal(await treeApi.getPreviewIndexHead({ fetchJson: recorder(srvErr(503, 'PREVIEW_INDEX_DISABLED')).fetchJson }), null)
  for (const reply of [srvErr(503, 'TREE_PROTOCOL_DISABLED'), srvErr(409, 'TREE_STATE_CONFLICT'), srvErr(404, 'NOT_FOUND'), srvErr(500, undefined), net()]) {
    await assert.rejects(treeApi.getPreviewIndexHead({ fetchJson: recorder(reply).fetchJson }), (e) => e instanceof treeApi.TreeApiError && e.status === reply.status, JSON.stringify(reply))
  }
})

test('PIC-3 envelopes: empty list makes no request; server errors throw TreeApiError', async () => {
  const r = recorder(ok({ blobs: [] }))
  assert.deepEqual(await treeApi.getPreviewIndexEnvelopes([], { fetchJson: r.fetchJson }), [])
  assert.equal(r.calls.length, 0)
  const env = { id: ID1, formatVersion: 2 }
  assert.deepEqual(await treeApi.getPreviewIndexEnvelopes([ID1], { fetchJson: recorder(ok({ blobs: [env] })).fetchJson }), [env])
  await assert.rejects(treeApi.getPreviewIndexEnvelopes([ID1], { fetchJson: recorder(srvErr(400, 'INVALID_INPUT')).fetchJson }), (e) => e.code === 'INVALID_INPUT')
  await assert.rejects(treeApi.listPreviewIndexBlobs({}, { fetchJson: recorder(srvErr(503, 'PREVIEW_INDEX_DISABLED')).fetchJson }), (e) => e.code === 'PREVIEW_INDEX_DISABLED')
})

test('PIC-4 PR-A ships no preview-index write wrapper and the module touches no browser storage', async () => {
  for (const name of Object.keys(treeApi)) assert.doesNotMatch(name, /^(cas|put|post|delete|upload).*PreviewIndex|PreviewIndex.*(Cas|Write|Upload|Delete)/, name)
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/lib/vaultTreeApi.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /\b(localStorage|sessionStorage|indexedDB|caches\.)/)
})
