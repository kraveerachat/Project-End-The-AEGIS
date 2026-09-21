// tests/vaultTreeApiClient.test.js — AEGIS Drive (IDEA1) · PR #157 Task 3.2 · vaultTreeApi client wrappers (TC-*)
//
// TC-1 ทุกฟังก์ชันส่งเฉพาะฟิลด์ opaque ที่ประกาศไว้ (body snapshot ตรงเป๊ะ), ส่ง signal ต่อทุกครั้ง,
//      คืน ciphertext ดิบจาก fetchBytes และส่ง bytes ดิบขึ้นเซิร์ฟเวอร์
// TC-2 ทุกฟังก์ชันแมป { code } ของเซิร์ฟเวอร์เป็น TreeApiError (คง status/data — UI ตัดสินจากโค้ดจริง)
// TC-3 apiFetch ส่ง body เป็น Uint8Array ดิบได้ (PUT ciphertext) — ห้าม JSON.stringify ทับ
import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFetch } from '../src/lib/api.js'
import * as treeApiMod from '../src/lib/vaultTreeApi.js'
const { TreeApiError } = treeApiMod

const ok = (data = {}, status = 200) => ({ ok: true, status, data, errorKind: null })
const srvErr = (status, code) => ({ ok: false, status, data: { error: 'e', code }, errorKind: 'server' })

function recorder(reply) {
  const calls = []
  const fetchJson = async (path, opts = {}) => { calls.push({ transport: 'json', path, opts }); return reply }
  const fetchBytes = async (path, opts = {}) => { calls.push({ transport: 'bytes', path, opts }); return reply.ok === false ? reply : { ok: true, status: 200, bytes: new Uint8Array([9, 9]), headers: null, errorKind: null } }
  return { fetchJson, fetchBytes, calls }
}

const SIGNAL = new AbortController().signal
const ID_A = 'A'.repeat(22)
const ID_B = 'B'.repeat(22)

const publishMeta = { revisionId: ID_A, baseRevisionId: null, generation: 1, ivB64: 'iv0', wrappedManifestDekB64: 'wm', wrapIvB64: 'wv', manifestSchemaVersion: 1, idempotencyKey: ID_B }
const casHeadBody = { expectedGeneration: 1, expectedRevisionId: ID_A, revisionId: ID_B, attachBlobIds: [{ formatVersion: 2, id: 'x' }], purgeBlobIds: [], idempotencyKey: 'c'.repeat(22) }
const envelopeBody = { expectedEnvelopeCasVersion: 1, primary: { wrappedTrkB64: 'p', wrapIvB64: 'pi' }, recovery: { wrappedTrkB64: 'r', wrapIvB64: 'ri' } }
const genesisBody = {
  leaseId: 'L'.repeat(22), epoch: 1, frozenInventoryId: 'F'.repeat(22), treeId: 'T'.repeat(22), ownerScopeIdB64: 'O'.repeat(22),
  keyEnvelope: envelopeBody,
  revision: { revisionId: ID_A, ivB64: 'iv0', wrappedManifestDekB64: 'wm', wrapIvB64: 'wv', manifestSchemaVersion: 1 },
  idempotencyKey: ID_B,
}
const purgeBody = { purgeId: 'P'.repeat(22), expectedGeneration: 1, expectedRevisionId: ID_A, barrierGeneration: 0, blobIds: [{ formatVersion: 1, id: 'x' }], idempotencyKey: ID_B }

const CASES = [
  ['getTreeState', [], { method: 'GET', path: '/api/vault/tree/state', body: undefined }],
  ['getTreeHead', [], { method: 'GET', path: '/api/vault/tree/head', body: undefined }],
  ['getRevisionCiphertext', ['REV'], { path: '/api/vault/tree/revisions/REV', body: undefined, bytes: true }],
  ['publishRevision', [publishMeta], { method: 'POST', path: '/api/vault/tree/revisions', body: publishMeta }],
  ['putRevisionCiphertext', ['REV', new Uint8Array([1, 2, 3])], { method: 'PUT', path: '/api/vault/tree/revisions/REV/ciphertext', body: new Uint8Array([1, 2, 3]), rawBytes: true }],
  ['casHead', [casHeadBody], { method: 'POST', path: '/api/vault/tree/head', body: casHeadBody }],
  ['casKeyEnvelope', [envelopeBody], { method: 'POST', path: '/api/vault/tree/key-envelope', body: envelopeBody }],
  ['listTreeBlobs', [], { method: 'GET', path: '/api/vault/tree/blobs', body: undefined }],
  ['beginMigration', [], { method: 'POST', path: '/api/vault/tree/migration/begin', body: {} }],
  ['takeoverMigration', [], { method: 'POST', path: '/api/vault/tree/migration/takeover', body: {} }],
  ['abandonMigration', [{ leaseId: 'L'.repeat(22) }], { method: 'POST', path: '/api/vault/tree/migration/abandon', body: { leaseId: 'L'.repeat(22) } }],
  ['commitGenesis', [genesisBody], { method: 'POST', path: '/api/vault/tree/genesis', body: genesisBody }],
  ['confirmPurge', [purgeBody], { method: 'POST', path: '/api/vault/tree/purge/confirm', body: purgeBody }],
]

test('TC-1 every vaultTreeApi function serializes only the documented opaque fields; signal forwarded; ciphertext bytes raw both ways', async () => {
  for (const [fn, args, want] of CASES) {
    const { fetchJson, fetchBytes, calls } = recorder(ok({}))
    const out = await treeApiMod[fn](...args, { fetchJson, fetchBytes, signal: SIGNAL })
    assert.equal(calls.length, 1, fn)
    assert.equal(calls[0].path, want.path, fn)
    assert.equal(calls[0].opts.signal, SIGNAL, `${fn}: signal`)
    if (want.bytes) {
      assert.equal(calls[0].transport, 'bytes', fn)
      assert.deepEqual([...out], [9, 9], fn)
    } else if (want.rawBytes) {
      assert.equal(calls[0].opts.method, want.method, fn)
      assert.ok(calls[0].opts.body instanceof Uint8Array, `${fn}: raw byte body`)
      assert.deepEqual([...calls[0].opts.body], [...want.body], fn)
    } else {
      assert.equal(calls[0].opts.method, want.method, fn)
      assert.deepEqual(calls[0].opts.body, want.body, fn)
    }
  }
})

test('TC-2 every function maps a server { code } to TreeApiError carrying status/data; falls back to errorKind', async () => {
  for (const [fn, args] of CASES) {
    const { fetchJson, fetchBytes } = recorder(srvErr(409, 'TREE_STATE_CONFLICT'))
    await assert.rejects(treeApiMod[fn](...args, { fetchJson, fetchBytes }), (e) => {
      assert.ok(e instanceof TreeApiError, fn)
      assert.equal(e.code, 'TREE_STATE_CONFLICT', fn)
      assert.equal(e.status, 409, fn)
      return true
    })
  }
  const { fetchJson } = recorder({ ok: false, status: 0, data: null, errorKind: 'network' })
  await assert.rejects(treeApiMod.getTreeState({ fetchJson }), (e) => e instanceof TreeApiError && e.code === 'network')
})

test('TC-3 apiFetch forwards a Uint8Array body as raw bytes without JSON stringification (ciphertext PUT)', async (t) => {
  const orig = globalThis.fetch
  let captured = null
  globalThis.fetch = async (_url, opts) => {
    captured = opts
    return new Response(JSON.stringify({ revisionId: 'r', state: 'PUBLISHED', ciphertextSize: 3 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = orig })
  const r = await apiFetch('/api/vault/tree/revisions/REV/ciphertext', { method: 'PUT', body: new Uint8Array([1, 2, 3]) })
  assert.equal(r.ok, true)
  assert.equal(r.data.state, 'PUBLISHED')
  assert.ok(captured.body instanceof Uint8Array)
  assert.deepEqual([...captured.body], [1, 2, 3])
  assert.notEqual(captured.headers['Content-Type'], 'application/json')
})
