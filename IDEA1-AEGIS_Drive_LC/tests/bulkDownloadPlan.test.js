// tests/bulkDownloadPlan.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 2b/2c
//
// The plan step is synchronous and pure: it runs inside the click (Files) or before the
// confirmation (Vault), so every refusal happens before any picker, dialog or fetch (spec §4).
// It copies only scalar fields into frozen objects and never freezes or mutates live screen data.
import test from 'node:test'
import assert from 'node:assert/strict'

import { needsZip64End } from '../src/lib/zipStreamWriter.js'
import {
  zipLayout, planBulkDownload, BULK_ZIP_ENABLED, ZIP_THRESHOLD, MAX_ZIP_ENTRIES,
} from '../src/lib/bulkDownloadPlan.js'

const MiB = 1024 * 1024
const NOW = new Date(2026, 9, 5, 7, 8, 9) // local time 2026-10-05 07:08:09

/* ── 2b zipLayout ────────────────────────────────────────────────── */

const assertPredicateUsed = (layout, entryCount) => {
  assert.equal(layout.z64End, needsZip64End({ entryCount, cdSize: layout.cdSize, cdStart: layout.cdStart }))
}

test('LAYOUT-1 one 5-byte-name entry of 3 bytes totals 127', () => {
  const l = zipLayout([{ nameBytes: 5, size: 3 }])
  assert.equal(l.total, (30 + 5 + 3 + 16) + (46 + 5) + 22)
  assert.equal(l.total, 127)
  assert.equal(l.cdStart, 54)
  assert.equal(l.cdSize, 51)
  assert.equal(l.z64End, false)
  assertPredicateUsed(l, 1)
})

test('LAYOUT-2 a zero-byte entry has L = 30 + n and D = 16', () => {
  const l = zipLayout([{ nameBytes: 4, size: 0 }])
  assert.equal(l.entries[0].localSize, 34)
  assert.equal(l.entries[0].descriptorSize, 16)
  assert.equal(l.total, 34 + 16 + 46 + 4 + 22)
})

test('LAYOUT-3 size 0xFFFFFFFF is size-ZIP64 with the ZIP64 end records', () => {
  const n = 5
  const s = 0xFFFFFFFF
  const l = zipLayout([{ nameBytes: n, size: s }])
  const e = l.entries[0]
  assert.equal(e.sizeZ64, true)
  assert.equal(e.offZ64, false)
  assert.equal(e.localSize, 50 + n)
  assert.equal(e.descriptorSize, 24)
  assert.equal(e.centralSize, 46 + n + 4 + 8 * 2)
  assert.equal(l.cdStart, 50 + n + s + 24)
  assert.equal(l.z64End, true)
  assert.equal(l.total, l.cdStart + l.cdSize + 76 + 22)
  assertPredicateUsed(l, 1)
})

test('LAYOUT-4 size 0xFFFFFFFE is a classic entry', () => {
  const l = zipLayout([{ nameBytes: 5, size: 0xFFFFFFFE }])
  assert.equal(l.entries[0].sizeZ64, false)
  assert.equal(l.entries[0].localSize, 35)
  assert.equal(l.entries[0].descriptorSize, 16)
  assert.equal(l.entries[0].centralSize, 51)
  // cdStart = 35 + 0xFFFFFFFE + 16 crosses 0xFFFFFFFF, so the archive still needs ZIP64 end records
  assertPredicateUsed(l, 1)
  assert.equal(l.z64End, true)
})

test('LAYOUT-5 offset-only ZIP64 via the test-only startOffset; every offset includes S', () => {
  const S = 0xFFFFFFFF
  const l = zipLayout([{ nameBytes: 5, size: 5 }], { startOffset: S })
  const e = l.entries[0]
  assert.equal(e.offset, S)
  assert.equal(e.offZ64, true)
  assert.equal(e.sizeZ64, false)
  assert.equal(e.centralSize, 46 + 5 + 12)
  assert.equal(l.cdStart, S + 35 + 5 + 16)
  assert.equal(l.z64End, true)
  assert.equal(l.total, l.cdStart + l.cdSize + 76 + 22)
  assertPredicateUsed(l, 1)

  const classic = zipLayout([{ nameBytes: 5, size: 5 }], { startOffset: 0xFFFFFFFE })
  assert.equal(classic.entries[0].offZ64, false)
  assert.equal(classic.entries[0].centralSize, 51)
  assertPredicateUsed(classic, 1)
})

test('LAYOUT-6 a second entry starts where the first ends; names may be given as strings', () => {
  const l = zipLayout([{ name: 'ab', size: 10 }, { name: 'ก', size: 0 }])
  assert.equal(l.entries[0].offset, 0)
  assert.equal(l.entries[1].offset, 30 + 2 + 10 + 16)
  assert.equal(l.entries[1].localSize, 30 + 3)
  assert.equal(l.payloadTotal, 10)
  assertPredicateUsed(l, 2)
})

test('LAYOUT-7 cdStart-triggered end records at 0xFFFFFFFE vs 0xFFFFFFFF via startOffset', () => {
  const below = zipLayout([{ nameBytes: 1, size: 0 }], { startOffset: 0xFFFFFFFE - (30 + 1 + 16) })
  assert.equal(below.cdStart, 0xFFFFFFFE)
  assert.equal(below.z64End, false)
  const at = zipLayout([{ nameBytes: 1, size: 0 }], { startOffset: 0xFFFFFFFF - (30 + 1 + 16) })
  assert.equal(at.cdStart, 0xFFFFFFFF)
  assert.equal(at.z64End, true)
  assert.equal(at.entries[0].offZ64, false)
})

/* ── 2c planBulkDownload ─────────────────────────────────────────── */

const row = (i, over = {}) => ({ id: `f${i}`, name: `file${i}.txt`, kind: 'file', type: 'Text', size: 10 + i, ...over })
const folderRow = (i) => ({ id: `d${i}`, name: `dir${i}`, kind: 'folder', type: 'Folder', size: 0 })
const filesPlan = (rows, opts = {}) => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return planBulkDownload({
    source: 'files', items: opts.ids ?? rows.map((r) => r.id), resolve: (id) => byId.get(id) ?? null,
    fsa: opts.fsa ?? true, enabled: opts.enabled ?? true, now: NOW,
  })
}

const blobRec = (i, over = {}) => ({
  id: `B${i}`, formatVersion: 2, size: 1000 + 16, chunkSize: 32 * MiB + 16, chunkCount: 1,
  contentIdB64: 'cid', wrappedDekB64: 'wd', wrapIvB64: 'wi', metaIvB64: 'mi', metaB64: 'mb', createdAt: 1, extra: 'x', ...over,
})
const fileNode = (i, over = {}) => ({
  nodeId: `n${i}`, kind: 'file', name: `v${i}.bin`, plainSize: 1000, blobRef: { formatVersion: 2, id: `B${i}` }, ...over,
})
const vaultPlan = (nodes, blobs, opts = {}) => {
  const index = new Map(blobs.map((b) => [`${b.formatVersion}:${b.id}`, b]))
  return planBulkDownload({
    source: 'vault', items: nodes,
    resolve: (n) => (n.blobRef ? index.get(`${n.blobRef.formatVersion}:${n.blobRef.id}`) ?? null : null),
    fsa: opts.fsa ?? true, enabled: opts.enabled ?? true, now: NOW,
  })
}
const range = (n) => Array.from({ length: n }, (_, i) => i)

test('PLAN-1 constants: threshold 4, cap 1000, feature off on landing (PR-1)', () => {
  assert.equal(ZIP_THRESHOLD, 4)
  assert.equal(MAX_ZIP_ENTRIES, 1000)
  assert.equal(BULK_ZIP_ENABLED, false)
})

test('PLAN-2 counts: 0 none, 1–3 per-file, 4 and 1000 zip, 1001 refused too-many', () => {
  assert.equal(filesPlan([]).mode, 'none')
  for (const n of [1, 2, 3]) assert.equal(filesPlan(range(n).map((i) => row(i))).mode, 'per-file', `n=${n}`)
  for (const n of [4, 1000]) assert.equal(filesPlan(range(n).map((i) => row(i))).mode, 'zip', `n=${n}`)
  const over = filesPlan(range(1001).map((i) => row(i)))
  assert.equal(over.mode, 'refused')
  assert.equal(over.reason, 'too-many')
})

test('PLAN-3 folders are skipped and counted, before the threshold', () => {
  const a = filesPlan([row(1), row(2), row(3), folderRow(1), folderRow(2)])
  assert.equal(a.mode, 'per-file')
  assert.equal(a.skippedFolders, 2)
  assert.deepEqual(a.perFile.map((r) => r.id), ['f1', 'f2', 'f3'])
  const b = filesPlan([row(1), row(2), row(3), row(4), folderRow(1)])
  assert.equal(b.mode, 'zip')
  assert.equal(b.skippedFolders, 1)
  assert.equal(b.entries.length, 4)
})

test('PLAN-4 Files ids missing from the listing are unavailable before the threshold', () => {
  const rows = [row(1), row(2), row(3)]
  const p = filesPlan(rows, { ids: ['f1', 'f2', 'f3', 'gone'] })
  assert.equal(p.mode, 'per-file')
  assert.equal(p.unavailable, 1)
})

test('PLAN-5 a Vault file with no blobRef or no blob in the index is unavailable before the threshold (M-5)', () => {
  const nodes = [fileNode(1), fileNode(2), fileNode(3), fileNode(4)]
  const p = vaultPlan(nodes, [blobRec(1), blobRec(2), blobRec(3)])
  assert.equal(p.mode, 'per-file')
  assert.equal(p.unavailable, 1)
  const q = vaultPlan([fileNode(1), fileNode(2), fileNode(3), { nodeId: 'x', kind: 'file', name: 'x' }], [blobRec(1), blobRec(2), blobRec(3)])
  assert.equal(q.mode, 'per-file')
  assert.equal(q.unavailable, 1)
  const folders = vaultPlan([fileNode(1), { nodeId: 'f', kind: 'folder', name: 'dir' }], [blobRec(1)])
  assert.equal(folders.skippedFolders, 1)
})

test('PLAN-6 D-1: 4+ Vault entries with any V1 are refused; 3 with V1 stay per-file', () => {
  const v1 = fileNode(9, { blobRef: { formatVersion: 1, id: 'B9' } })
  const blobs = [blobRec(1), blobRec(2), blobRec(3), blobRec(9, { formatVersion: 1 })]
  const refused = vaultPlan([fileNode(1), fileNode(2), fileNode(3), v1], blobs)
  assert.equal(refused.mode, 'refused')
  assert.equal(refused.reason, 'v1-in-zip')
  const small = vaultPlan([fileNode(1), fileNode(2), v1], blobs)
  assert.equal(small.mode, 'per-file')
})

test('PLAN-7 no-FSA: exact length ≤ 64 MiB is buffered; above it Files fall back per-file and the Vault is refused', () => {
  const fixed = 4 * (30 + 9 + 16) + 4 * (46 + 9) + 22 // names file1.txt..file4.txt are 9 bytes
  const sized = (payload) => {
    const q = Math.floor(payload / 4)
    return range(4).map((i) => row(i + 1, { size: i === 0 ? payload - 3 * q : q }))
  }
  const atCap = 64 * MiB - fixed
  const ok = filesPlan(sized(atCap), { fsa: false })
  assert.equal(ok.mode, 'zip')
  assert.equal(ok.transport, 'buffered')
  assert.equal(ok.layout.total, 64 * MiB)
  const over = filesPlan(sized(atCap + 4), { fsa: false })
  assert.equal(over.mode, 'per-file')
  assert.equal(over.fallbackNotice, 'no-fsa-large')
  assert.equal(over.perFile.length, 4)

  const big = range(4).map((i) => fileNode(i + 1, { plainSize: 20 * MiB }))
  const blobs = range(4).map((i) => blobRec(i + 1))
  const v = vaultPlan(big, blobs, { fsa: false })
  assert.equal(v.mode, 'refused')
  assert.equal(v.reason, 'too-large')
  assert.equal(vaultPlan(range(4).map((i) => fileNode(i + 1)), blobs, { fsa: false }).transport, 'buffered')
})

test('PLAN-8 FSA transport and archive names in local time', () => {
  const f = filesPlan(range(4).map((i) => row(i)))
  assert.equal(f.transport, 'fsa')
  assert.equal(f.suggestedName, 'AEGIS-Files-20261005-070809.zip')
  const v = vaultPlan(range(4).map((i) => fileNode(i)), range(4).map((i) => blobRec(i)))
  assert.equal(v.suggestedName, 'AEGIS-Vault-export-20261005-070809.zip')
})

test('PLAN-9 feature flag off: per-file for every n', () => {
  for (const n of [4, 1000, 1001]) {
    const p = filesPlan(range(n).map((i) => row(i)), { enabled: false })
    assert.equal(p.mode, 'per-file', `n=${n}`)
    assert.equal(p.perFile.length, n)
  }
})

test('PLAN-10 entry names are assigned (sanitised + de-duplicated) in selection order', () => {
  const p = filesPlan([row(1, { name: 'a.txt' }), row(2, { name: 'A.txt' }), row(3, { name: '../x' }), row(4, { name: 'CON' })])
  assert.deepEqual(p.entries.map((e) => e.name), ['a.txt', 'A (2).txt', '.._x', '_CON'])
  assert.deepEqual(p.entries.map((e) => e.id), ['f1', 'f2', 'f3', 'f4'])
  assert.deepEqual(p.entries.map((e) => e.size), [11, 12, 13, 14])
})

test('PLAN-11 Vault provisional size and raw manifestPlainSize (SC-3)', () => {
  const nodes = [
    fileNode(1, { plainSize: 123 }),
    fileNode(2, { plainSize: '123' }),
    fileNode(3, { plainSize: undefined }),
    fileNode(4, { plainSize: -1 }),
  ]
  const blobs = range(4).map((i) => blobRec(i + 1, { size: 516, chunkCount: 1 }))
  const p = vaultPlan(nodes, blobs)
  assert.equal(p.mode, 'zip')
  assert.deepEqual(p.entries.map((e) => e.manifestPlainSize), [123, '123', undefined, -1])
  assert.deepEqual(p.entries.map((e) => e.size), [123, 500, 500, 500])
  assert.equal(typeof p.entries[1].manifestPlainSize, 'string')
  assert.deepEqual(p.entries[0].blobRef, { formatVersion: 2, id: 'B1' })
  assert.equal(p.entries[0].nodeId, 'n1')
  assert.deepEqual(Object.keys(p.entries[0].blob).sort(), [
    'chunkCount', 'chunkSize', 'contentIdB64', 'formatVersion', 'id', 'metaB64', 'metaIvB64', 'size', 'wrapIvB64', 'wrappedDekB64',
  ])
})

test('PLAN-12 immutable copies: plan frozen, originals untouched and extensible (I-4)', () => {
  const nodes = range(4).map((i) => fileNode(i))
  const blobs = range(4).map((i) => blobRec(i))
  const p = vaultPlan(nodes, blobs)
  assert.ok(Object.isFrozen(p))
  assert.ok(Object.isFrozen(p.entries))
  for (const e of p.entries) {
    assert.ok(Object.isFrozen(e))
    assert.ok(Object.isFrozen(e.blob))
    assert.ok(Object.isFrozen(e.blobRef))
  }
  for (const n of nodes) { assert.ok(Object.isExtensible(n)); assert.ok(!Object.isFrozen(n.blobRef)) }
  for (const b of blobs) assert.ok(Object.isExtensible(b))
  assert.notEqual(p.entries[0].blob, blobs[0])
  blobs[0].metaB64 = 'changed'
  assert.equal(p.entries[0].blob.metaB64, 'mb')

  const rows = range(4).map((i) => row(i))
  const f = filesPlan(rows)
  assert.ok(Object.isFrozen(f.entries[0]))
  for (const r of rows) assert.ok(Object.isExtensible(r))
})
