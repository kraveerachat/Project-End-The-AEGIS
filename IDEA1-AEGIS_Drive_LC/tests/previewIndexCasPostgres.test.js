// tests/previewIndexCasPostgres.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Task C.2 · preview-index CAS serialization on PostgreSQL 15
//
// ⚠️ Concurrency evidence can only come from a real PostgreSQL. Runs only against the disposable database from
//    scripts/pg-integration-env.sh (drive_app, non-superuser). Without TEST_DATABASE_URL every test is skipped with
//    an explicit reason — an evidence run must show 0 skips.
// ⚠️ One database per file: created from TEMPLATE aegis_drive_test with AEGIS_PGTEST_SUPER_URL and dropped in after().
// ⚠️ statement_timeout / lock_timeout = 5 s: a deadlock or a lock wait that never resolves fails the test instead of hanging.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

const TEST_URL = process.env.TEST_DATABASE_URL
const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const skip = TEST_URL ? false : 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'

let dbName = null, dbUrl = TEST_URL, superPool = null
if (!skip && SUPER_URL) {
  superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 })
  dbName = `aegis_drive_picas_${Date.now().toString(36)}`
  const template = new URL(TEST_URL).pathname.slice(1)
  await superPool.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`)
  await superPool.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
  await superPool.query(`GRANT CONNECT ON DATABASE ${dbName} TO drive_app`)
  const u = new URL(TEST_URL); u.pathname = '/' + dbName; dbUrl = u.toString()
}
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.PGOPTIONS = '-c statement_timeout=5000 -c lock_timeout=5000'
if (!skip) process.env.DATABASE_URL = dbUrl
else delete process.env.DATABASE_URL

const store = await import('../server/db/vaultPreviewIndexStore.js')
const tree = await import('../server/db/vaultTreeStore.js')
const v2 = await import('../server/db/vaultV2Store.js')
const { usingPostgres, closePool, createUserWithTempPassword, query } = await import('../server/db/connection.js')
const { ROLES } = await import('../server/rbac/permissions.js')
const { seedV2Blob } = await import('./helpers/previewIndexStoreSpec.mjs')
const { seedTreeOwner, casRequest } = await import('./helpers/previewIndexCasSpec.mjs')

before(() => { if (!skip) assert.equal(usingPostgres, true) })
after(async () => {
  if (skip) return
  await closePool()
  if (superPool && dbName) { await superPool.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await superPool.end() }
})

const deps = { tree, v2 }
const C = store.INDEX_STORE_CODE
let seq = 0
const ready = async () => {
  const u = await createUserWithTempPassword({ username: `picas${Date.now().toString(36)}${++seq}`, displayName: 'Preview Index CAS', role: ROLES.USER })
  assert.ok(u, 'disposable owner created')
  const id = String(u.id)
  const seeded = await seedTreeOwner(deps, id)
  return { id, ...seeded }
}
const staged = (u) => seedV2Blob(deps, u, { lifecycle: 'INDEX_STAGED' })
const lifecycleOf = async (u, id) => (await tree.listBlobStates(u)).find((s) => s.formatVersion === 2 && s.id === id)?.lifecycle ?? null
const opaque22 = () => randomBytes(16).toString('base64url')

test('PI-PG-CAS-1 two concurrent CAS on the same expected generation: exactly one winner; the loser sees the winner', { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    const { id: a } = await ready()
    const x = await staged(a), y = await staged(a)
    const [rx, ry] = await Promise.all([store.casIndexHead(a, casRequest({ root: x })), store.casIndexHead(a, casRequest({ root: y }))])
    const winners = [rx, ry].filter((r) => r.ok)
    assert.equal(winners.length, 1, JSON.stringify([rx, ry]))
    const loser = rx.ok ? ry : rx
    const winRoot = rx.ok ? x : y, loseRoot = rx.ok ? y : x
    assert.deepEqual(loser, { ok: false, code: C.PREVIEW_INDEX_CONFLICT, current: { indexGeneration: 1, rootBlobId: winRoot.id } })
    assert.equal(await lifecycleOf(a, winRoot.id), 'INDEX_MANAGED')
    assert.equal(await lifecycleOf(a, loseRoot.id), 'INDEX_STAGED', 'the loser\'s blob stays staged (and stays counted) — never deleted')
    assert.equal((await store.listIndexGenerations(a)).length, 1)
  }
})

test('PI-PG-CAS-2 20 parallel writers with retry: generations strictly sequential 1..20, no gaps, one row each', { skip }, async () => {
  const { id: a } = await ready()
  const roots = []
  for (let i = 0; i < 20; i++) roots.push(await staged(a))
  let conflicts = 0
  const writer = async (root) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const head = await store.getIndexHead(a)
      const r = await store.casIndexHead(a, casRequest({ root, expectedGeneration: head?.indexGeneration ?? 0, expectedRootBlobId: head?.rootBlobId ?? null }))
      if (r.ok) return r.indexGeneration
      assert.equal(r.code, C.PREVIEW_INDEX_CONFLICT, JSON.stringify(r))
      conflicts++
    }
    throw new Error('writer starved')
  }
  const won = await Promise.all(roots.map(writer))
  assert.deepEqual([...won].sort((p, q) => p - q), Array.from({ length: 20 }, (_, i) => i + 1), 'every writer got a distinct generation')
  const gens = await store.listIndexGenerations(a)
  assert.deepEqual(gens.map((g) => g.indexGeneration), Array.from({ length: 20 }, (_, i) => i + 1))
  for (const g of gens) assert.equal(g.baseGeneration, g.indexGeneration - 1)
  assert.deepEqual(gens.map((g) => g.supersededAt === null), [...Array(19).fill(false), true], 'only the head generation is not superseded')
  assert.equal((await store.getIndexHead(a)).indexGeneration, 20)
  for (const r of roots) assert.equal(await lifecycleOf(a, r.id), 'INDEX_MANAGED')
  assert.ok(conflicts > 0, 'contention actually happened')
})

test('PI-PG-CAS-3 concurrent main head CAS and index CAS for one owner both succeed (independent heads, no deadlock)', { skip }, async () => {
  for (let round = 0; round < 5; round++) {
    const { id: a, treeId, revisionId } = await ready()
    const userFile = await seedV2Blob(deps, a, { lifecycle: 'UNREFERENCED' })
    const root = await staged(a)
    const rev2 = opaque22(), key2 = opaque22()
    assert.equal((await tree.createRevision(a, {
      revisionId: rev2, treeId, baseRevisionId: revisionId, generation: 2, manifestSchemaVersion: 1,
      ivB64: randomBytes(12).toString('base64'), wrappedManifestDekB64: randomBytes(48).toString('base64'), wrapIvB64: randomBytes(12).toString('base64'), idempotencyKey: key2,
    })).ok, true)
    assert.equal((await tree.markRevisionPublished(a, rev2, { storageKey: `vault-tree/${rev2}.aegisenc`, ciphertextSize: 4112, sha256: 'b'.repeat(64) })).ok, true)
    const [main, index] = await Promise.all([
      tree.casHead(a, { expectedGeneration: 1, expectedRevisionId: revisionId, revisionId: rev2, attachBlobRefs: [{ formatVersion: 2, id: userFile.id }], idempotencyKey: key2 }),
      store.casIndexHead(a, casRequest({ root })),
    ])
    assert.equal(main.ok, true, JSON.stringify(main))
    assert.equal(index.ok, true, JSON.stringify(index))
    assert.equal((await tree.getHead(a)).generation, 2)
    assert.equal((await store.getIndexHead(a)).indexGeneration, 1)
    assert.equal(await lifecycleOf(a, userFile.id), 'TREE_MANAGED')
    assert.equal(await lifecycleOf(a, root.id), 'INDEX_MANAGED')
  }
})

test('PI-PG-CAS-4 lost response + retry → idempotent replay; concurrent duplicates → one commit + one replay', { skip }, async () => {
  const { id: a } = await ready()
  const root = await staged(a)
  const req = casRequest({ root })
  await store.casIndexHead(a, req) // response "lost"
  const retry = await store.casIndexHead(a, req)
  assert.deepEqual(retry, { ok: true, replay: true, indexGeneration: 1, rootBlobId: root.id })
  assert.equal((await store.listIndexGenerations(a)).length, 1)

  const { id: b } = await ready()
  const rb = await staged(b)
  const dup = casRequest({ root: rb })
  const results = await Promise.all([store.casIndexHead(b, dup), store.casIndexHead(b, dup), store.casIndexHead(b, dup)])
  assert.ok(results.every((r) => r.ok && r.indexGeneration === 1 && r.rootBlobId === rb.id), JSON.stringify(results))
  assert.equal(results.filter((r) => !r.replay).length, 1, 'exactly one real commit')
  assert.equal((await store.listIndexGenerations(b)).length, 1)
})

test('PI-PG-CAS-5 a reused idempotency key with a different body is rejected, also under concurrency', { skip }, async () => {
  const { id: a } = await ready()
  const x = await staged(a), y = await staged(a)
  const key = opaque22()
  const [rx, ry] = await Promise.all([store.casIndexHead(a, casRequest({ root: x, key })), store.casIndexHead(a, casRequest({ root: y, key }))])
  const ok = [rx, ry].filter((r) => r.ok)
  assert.equal(ok.length, 1, JSON.stringify([rx, ry]))
  const other = rx.ok ? ry : rx
  assert.ok([C.PREVIEW_INDEX_IDEMPOTENCY_MISMATCH, C.PREVIEW_INDEX_CONFLICT].includes(other.code), JSON.stringify(other))
  const later = await store.casIndexHead(a, casRequest({ root: rx.ok ? y : x, key, expectedGeneration: 1, expectedRootBlobId: (rx.ok ? x : y).id }))
  assert.deepEqual(later, { ok: false, code: C.PREVIEW_INDEX_IDEMPOTENCY_MISMATCH })
  assert.equal((await store.listIndexGenerations(a)).length, 1)
})

test('PI-PG-CAS-6 a blob promoted by one CAS cannot be attached again by a concurrent CAS', { skip }, async () => {
  const { id: a } = await ready()
  const shared = await staged(a), r1 = await staged(a), r2 = await staged(a)
  const [p, q] = await Promise.all([
    store.casIndexHead(a, casRequest({ root: r1, attach: [r1.id, shared.id] })),
    store.casIndexHead(a, casRequest({ root: r2, attach: [r2.id, shared.id] })),
  ])
  assert.equal([p, q].filter((r) => r.ok).length, 1)
  const winRoot = p.ok ? r1 : r2, loseRoot = p.ok ? r2 : r1
  const retry = await store.casIndexHead(a, casRequest({ root: loseRoot, attach: [loseRoot.id, shared.id], expectedGeneration: 1, expectedRootBlobId: winRoot.id }))
  assert.deepEqual(retry, { ok: false, code: C.PREVIEW_INDEX_BLOB_STATE_CONFLICT })
  assert.equal(await lifecycleOf(a, loseRoot.id), 'INDEX_STAGED')
  const refs = (await query(`SELECT count(*)::int AS n FROM vault_preview_index_blob_refs WHERE user_id = $1 AND blob_id = $2 AND role = 'ATTACHED'`, [a, shared.id])).rows[0].n
  assert.equal(refs, 1, 'attached by exactly one generation')
})
