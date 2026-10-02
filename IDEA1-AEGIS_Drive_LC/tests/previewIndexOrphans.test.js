// tests/previewIndexOrphans.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Tasks D.1 / D.2 (lib) / D.4
//
// D.1  classification uses the DECRYPTED, AEAD-authenticated V2 metadata only — never a server-supplied field.
// D.2  listOrphanBlobs never offers reserved preview-index blobs; recoverOrphan refuses an empty name (fail closed).
// D.4  read-only reachability report: counts only, no mutation, never automatic.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { BLOB_CLASS, classifyDecryptedMeta, reachabilityReport } from '../src/lib/vaultPreviewIndexOrphans.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER } from '../src/lib/vaultPreviewIndexConstants.js'

test('PIO-1 classifyDecryptedMeta: markers, derivatives, unnamed, named and undecryptable', () => {
  const cases = [
    [{ name: '', type: INDEX_ROOT_MARKER, plainSize: 4096 }, BLOB_CLASS.INDEX_ROOT],
    [{ name: '', type: INDEX_SHARD_MARKER, plainSize: 16384 }, BLOB_CLASS.INDEX_SHARD],
    [{ name: '', type: 'image/jpeg', plainSize: 9 }, BLOB_CLASS.DERIVATIVE],
    [{ name: '', type: 'image/webp', plainSize: 9 }, BLOB_CLASS.DERIVATIVE],
    [{ name: '', type: 'image/png', plainSize: 9 }, BLOB_CLASS.UNNAMED_USER],
    [{ name: '', type: 'application/octet-stream', plainSize: 9 }, BLOB_CLASS.UNNAMED_USER],
    [{ name: '', type: '', plainSize: 0 }, BLOB_CLASS.UNNAMED_USER],
    [{ name: 'holiday.jpg', type: 'image/jpeg', plainSize: 9 }, BLOB_CLASS.USER],
    [{ name: 'report.pdf', type: INDEX_ROOT_MARKER, plainSize: 9 }, BLOB_CLASS.USER], // a user file is never hidden because of its type
    [{ name: 'x', type: INDEX_SHARD_MARKER, plainSize: 9 }, BLOB_CLASS.USER],
    [null, BLOB_CLASS.UNDECRYPTABLE],
    [undefined, BLOB_CLASS.UNDECRYPTABLE],
    [{ type: INDEX_ROOT_MARKER }, BLOB_CLASS.UNNAMED_USER], // missing name is never a reserved object
    [{ name: 7, type: INDEX_ROOT_MARKER }, BLOB_CLASS.UNNAMED_USER],
    ['not-an-object', BLOB_CLASS.UNDECRYPTABLE],
  ]
  for (const [meta, want] of cases) assert.equal(classifyDecryptedMeta(meta), want, JSON.stringify(meta))
  assert.deepEqual(Object.keys(BLOB_CLASS).sort(), ['DERIVATIVE', 'INDEX_ROOT', 'INDEX_SHARD', 'UNDECRYPTABLE', 'UNNAMED_USER', 'USER'])
  assert.ok(Object.isFrozen(BLOB_CLASS))
})

test('PIO-2 classification ignores every server-supplied field (lifecycle, size, id, createdAt, envelope)', () => {
  const meta = { name: 'notes.txt', type: 'text/plain', plainSize: 3 }
  for (const serverish of [{ lifecycle: 'INDEX_MANAGED' }, { lifecycle: 'INDEX_STAGED', size: 1 }, { formatVersion: 2, id: 'a'.repeat(48), contentIdB64: 'x' }]) {
    assert.equal(classifyDecryptedMeta({ ...meta, ...serverish }), BLOB_CLASS.USER)
  }
  assert.equal(classifyDecryptedMeta({ name: '', type: INDEX_ROOT_MARKER, lifecycle: 'UNREFERENCED' }), BLOB_CLASS.INDEX_ROOT)
  const src = fs.readFileSync(new URL('../src/lib/vaultPreviewIndexOrphans.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function classifyDecryptedMeta'), src.indexOf('\n}\n', src.indexOf('export function classifyDecryptedMeta')))
  assert.doesNotMatch(fn, /lifecycle|\.size\b|\.id\b|contentId|createdAt|formatVersion/, 'the classifier reads only name/type')
})

// ── D.2 (lib): listOrphanBlobs / recoverOrphan with real V2 crypto ──────────
const { createVaultV2Envelope } = await import('../src/lib/vaultChunkCrypto.js')
const { listOrphanBlobs, listOrphanBlobsDetailed, recoverOrphan } = await import('../src/lib/vaultTreeUpload.js')
const newKek = () => globalThis.crypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'])

async function v2Blob(kek, id, meta, lifecycle = 'UNREFERENCED') {
  const env = await createVaultV2Envelope(kek, { name: meta.name, type: meta.type, size: meta.size ?? 10, chunkCount: 1 })
  return { id, formatVersion: 2, size: 26, createdAt: 1, contentIdB64: env.contentIdB64, chunkSize: 1040, chunkCount: 1, wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64, lifecycle }
}

test('PIO-3 listOrphanBlobs hides INDEX_ROOT/INDEX_SHARD/DERIVATIVE (counted in reservedHidden only); lists user, unnamed and undecryptable', async () => {
  const kek = await newKek(), other = await newKek()
  const id = (n) => String(n).padStart(48, 'a')
  const blobs = [
    await v2Blob(kek, id(1), { name: '', type: INDEX_ROOT_MARKER }),
    await v2Blob(kek, id(2), { name: '', type: INDEX_SHARD_MARKER }),
    await v2Blob(kek, id(3), { name: '', type: 'image/webp' }),
    await v2Blob(kek, id(4), { name: 'kept.pdf', type: 'application/pdf' }),
    await v2Blob(kek, id(5), { name: '', type: 'text/plain' }),
    await v2Blob(other, id(6), { name: 'foreign.bin', type: 'application/octet-stream' }),
    await v2Blob(kek, id(7), { name: 'mine.txt', type: INDEX_ROOT_MARKER }),
    await v2Blob(kek, id(8), { name: '', type: INDEX_ROOT_MARKER }, 'INDEX_MANAGED'), // a malicious/old server leaking an INDEX_* row
  ]
  const calls = []
  const api = { listTreeBlobs: async (o) => { calls.push(o); return { blobs, orphanRetentionMs: 1 } } }
  const r = await listOrphanBlobsDetailed({ kek, api, index: { nodes: new Map() } })
  assert.deepEqual(calls.map((c) => c.lifecycle), ['UNREFERENCED'], 'only the recoverable lifecycle is ever requested')
  assert.deepEqual(r.orphans.map((o) => o.blobRef.id), [id(4), id(5), id(6), id(7)])
  assert.equal(r.reservedHidden, 3)
  assert.deepEqual(Object.keys(r).sort(), ['orphans', 'reservedHidden'], 'counts only — no ids or names of hidden blobs')
  assert.deepEqual((await listOrphanBlobs({ kek, api, index: { nodes: new Map() } })).map((o) => o.blobRef.id), [id(4), id(5), id(6), id(7)])
  const unnamed = r.orphans.find((o) => o.blobRef.id === id(5))
  assert.equal(unnamed.name, '', 'the unnamed file carries no invented display name')
  assert.equal(r.orphans.find((o) => o.blobRef.id === id(6)).undecryptable, true)
})

test('PIO-4 recoverOrphan fails closed without an explicit non-empty name — no commit is attempted', async () => {
  let commits = 0
  const session = { commit: async () => { commits++; return { generation: 2, revisionId: 'r' } } }
  for (const name of ['', '   ', null, undefined, 7]) {
    await assert.rejects(recoverOrphan({ session, blobRef: { formatVersion: 2, id: 'a'.repeat(48) }, parentNodeId: 'R'.repeat(22), name }), (e) => e.code === 'NAME_REQUIRED', String(name))
  }
  assert.equal(commits, 0)
})

// ── D.4: read-only reachability report ───────────────────────────────────────
function fakeReader({ head, root, shards }) {
  return {
    snapshot: () => ({ head, root }),
    shardOf: async (prefix) => shards.get(prefix) ?? null,
  }
}
const bref = (id) => ({ formatVersion: 2, id })

test('PIO-5 reachabilityReport counts reachable / stagedUnreachable / managedUnreachable from paginated listing; counts only', async () => {
  const id = (n) => String(n).padStart(48, 'c')
  const shardA = { prefix: '000000', entries: new Map([['N'.repeat(22), [{ kind: 'thumb', blobRef: bref(id(10)) }, { kind: 'poster', blobRef: bref(id(11)) }]]]) }
  const shardB = { prefix: '111111', entries: new Map([['M'.repeat(22), [{ kind: 'thumb', blobRef: bref(id(12)) }]]]) }
  const root = { indexGeneration: 3, shards: [{ prefix: '000000', blobRef: bref(id(2)) }, { prefix: '111111', blobRef: bref(id(3)) }] }
  const reader = fakeReader({ head: { indexGeneration: 3, rootBlobRef: bref(id(1)) }, root, shards: new Map([['000000', shardA], ['111111', shardB]]) })
  const listing = [
    ...[1, 2, 3, 10, 11, 12].map((n) => ({ id: id(n), lifecycle: 'INDEX_MANAGED' })), // reachable
    { id: id(20), lifecycle: 'INDEX_MANAGED' }, { id: id(21), lifecycle: 'INDEX_MANAGED' }, // superseded generations
    { id: id(30), lifecycle: 'INDEX_STAGED' }, // upload succeeded, CAS lost
  ].sort((a, b) => (a.id < b.id ? -1 : 1))
  const requests = []
  const api = {
    listPreviewIndexBlobs: async ({ after, limit }) => {
      requests.push({ after, limit })
      const start = after ? listing.findIndex((x) => x.id === after) + 1 : 0
      const page = listing.slice(start, start + limit)
      return { blobs: page.map((x) => ({ ...x, createdAt: 1 })), next: start + limit < listing.length ? page[page.length - 1].id : null }
    },
  }
  const report = await reachabilityReport({ reader, api, pageSize: 4 })
  assert.deepEqual(report, { reachable: 6, stagedUnreachable: 1, managedUnreachable: 2, generationsRetained: 3 })
  assert.ok(requests.length >= 3, 'paginated')
  assert.ok(requests.every((r) => r.limit === 4))
  assert.equal(JSON.stringify(report).includes(id(30)), false)
})

test('PIO-6 reachabilityReport with no index: everything listed is unreachable; never mutates; module never runs on its own', async () => {
  const reader = { snapshot: () => ({ head: null, root: null }), shardOf: async () => null }
  const api = { listPreviewIndexBlobs: async () => ({ blobs: [{ id: 'd'.repeat(48), lifecycle: 'INDEX_STAGED', createdAt: 1 }], next: null }) }
  assert.deepEqual(await reachabilityReport({ reader, api }), { reachable: 0, stagedUnreachable: 1, managedUnreachable: 0, generationsRetained: 0 })
  const src = fs.readFileSync(new URL('../src/lib/vaultPreviewIndexOrphans.js', import.meta.url), 'utf8')
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  assert.doesNotMatch(code, /\b(cas[A-Z]\w*|delete\w*|purge\w*|upload\w*|fetch|apiFetch|localStorage|sessionStorage|indexedDB|method:)/i, 'no mutating call, no transport of its own, no storage')
  const screens = ['src/screens/VaultTreeScreen.jsx', 'src/screens/Vault.jsx', 'src/lib/vaultUnlockedState.js', 'src/lib/vaultTreeSync.js']
  for (const p of screens) assert.doesNotMatch(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'), /reachabilityReport|vaultPreviewIndexOrphans/, `${p} must not run the report automatically`)
})
