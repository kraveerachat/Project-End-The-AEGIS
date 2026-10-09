// tests/bulkZipNoFsa.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 9b
//
// spec §14: without File System Access the archive is buffered only when its EXACT length is ≤ 64 MiB
// (an archive-size policy cap, not a process-RAM guarantee). Files above it fall back to per-file
// anchors; the Vault above it is refused. The Vault re-checks the cap on the authenticated sizes.
// No picker on this path; the result is one application/zip Blob, one anchor click, revoke after 10 s.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import { runBulkZip, createFilesEntrySource, finalizeBufferedZip } from '../src/lib/bulkZipDownload.js'
import { planBulkDownload, zipLayout } from '../src/lib/bulkDownloadPlan.js'
import { createBufferedSink } from '../src/lib/vaultChunkedDownload.js'

const MiB = 1024 * 1024
let dom
let clicks
before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  globalThis.document = dom.window.document
  clicks = []
  dom.window.document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]')
    if (a) { clicks.push({ href: a.getAttribute('href'), download: a.download, attached: a.isConnected }); e.preventDefault() }
  }, true)
})
after(() => { delete globalThis.document; dom.window.close() })

function bytesOf(n, seed = 1) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 11 + seed) & 0xff
  return b
}

function transportFor(rows) {
  const calls = []
  const fetchStream = async (path) => {
    const id = path.split('/')[3]
    calls.push(id)
    const row = rows.find((r) => r.id === id)
    const bytes = bytesOf(row.size)
    return {
      ok: true, status: 200, errorKind: null, headers: new Headers({ 'Content-Length': String(row.size) }),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }),
    }
  }
  return { fetchStream, calls }
}

function urlSpy(t) {
  const created = []
  const revoked = []
  t.mock.method(URL, 'createObjectURL', (blob) => { created.push(blob); return `blob:test/${created.length}` })
  t.mock.method(URL, 'revokeObjectURL', (u) => { revoked.push(u) })
  return { created, revoked }
}

const rowsOf = (sizes) => sizes.map((size, i) => ({ id: `f${i}`, name: `file${i}.bin`, kind: 'file', type: 'Binary', size }))
const filesPlan = (rows) => planBulkDownload({ source: 'files', items: rows.map((r) => r.id), resolve: (id) => rows.find((r) => r.id === id) ?? null, fsa: false, enabled: true, now: new Date(2026, 9, 5, 1, 2, 3) })

test('NOFSA-1 Files ≤ 64 MiB: one application/zip Blob, one anchor click, no picker, revoke after 10 s, ZIP parses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const urls = urlSpy(t)
  clicks.length = 0
  const rows = rowsOf([5, 0, 300, 12])
  const plan = filesPlan(rows)
  assert.equal(plan.transport, 'buffered')
  const transport = transportFor(rows)
  const scope = { showSaveFilePicker() { throw new Error('no picker on the buffered path') } }
  const res = await runBulkZip({ plan, source: createFilesEntrySource({ fetchStream: transport.fetchStream }), scope, busyRef: { current: false } })
  assert.equal(res.status, 'done')
  assert.equal(urls.created.length, 1)
  const blob = urls.created[0]
  assert.equal(blob.type, 'application/zip')
  assert.equal(blob.size, zipLayout(plan.entries).total)
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  assert.deepEqual([...head], [0x50, 0x4b, 3, 4])
  assert.deepEqual(clicks, [{ href: 'blob:test/1', download: 'AEGIS-Files-20261005-010203.zip', attached: true }])
  assert.equal(dom.window.document.querySelectorAll('a').length, 0, 'the anchor is removed again')
  assert.deepEqual(urls.revoked, [])
  t.mock.timers.tick(10_000)
  assert.deepEqual(urls.revoked, ['blob:test/1'])
})

test('NOFSA-2 Files above 64 MiB: per-file fallback with a notice; nothing buffered', () => {
  const rows = rowsOf([40 * MiB, 30 * MiB, 1, 1])
  const plan = filesPlan(rows)
  assert.equal(plan.mode, 'per-file')
  assert.equal(plan.fallbackNotice, 'no-fsa-large')
  assert.equal(plan.perFile.length, 4)
})

test('NOFSA-3 Vault ≤ 64 MiB: buffered; the object URL is registered so a lock revokes it', async (t) => {
  const urls = urlSpy(t)
  clicks.length = 0
  const registered = []
  const plan = Object.freeze({
    mode: 'zip', source: 'vault', transport: 'buffered', suggestedName: 'AEGIS-Vault-export-20261005-010203.zip',
    entries: Object.freeze([0, 1, 2, 3].map((i) => Object.freeze({ nodeId: `n${i}`, name: `v${i}.bin`, size: 4, blob: Object.freeze({ id: `B${i}` }) }))),
  })
  const source = {
    async preflight(p) { return { ok: true, effectivePlan: p } },
    async open(e) { return { ok: true, size: e.size, dispose() {}, async pump(sink) { await sink.write(bytesOf(4)); return { ok: true } } } },
  }
  const res = await runBulkZip({ plan, source, busyRef: { current: false }, registerObjectUrl: (u) => registered.push(u) })
  assert.equal(res.status, 'done')
  assert.deepEqual(registered, ['blob:test/1'])
  assert.equal(urls.created[0].type, 'application/zip')
  assert.equal(clicks.length, 1)
})

test('NOFSA-4 Vault re-check: provisional fits, authenticated does not → too-large after pre-flight, nothing written', async (t) => {
  const urls = urlSpy(t)
  const plan = Object.freeze({
    mode: 'zip', source: 'vault', transport: 'buffered', suggestedName: 'x.zip',
    entries: Object.freeze([0, 1, 2, 3].map((i) => Object.freeze({ nodeId: `n${i}`, name: `v${i}.bin`, size: 1, blob: Object.freeze({ id: `B${i}` }) }))),
  })
  let opens = 0
  const source = {
    async preflight(p) { return { ok: true, effectivePlan: Object.freeze({ ...p, entries: Object.freeze(p.entries.map((e) => Object.freeze({ ...e, size: 17 * MiB }))) }) } },
    async open() { opens += 1; return { ok: false, reason: 'x' } },
  }
  const writes = []
  const res = await runBulkZip({ plan, source, busyRef: { current: false }, createBufferedSink: () => ({ async write(b) { writes.push(b) }, async close() { return [] }, async abort() {} }) })
  assert.equal(res.reason, 'too-large')
  assert.equal(opens, 0)
  assert.equal(writes.length, 0)
  assert.equal(urls.created.length, 0)
})

test('NOFSA-5 Vault above 64 MiB at plan time is refused before anything runs', () => {
  const blobs = [0, 1, 2, 3].map((i) => ({ id: `B${i}`, formatVersion: 2, size: 20 * MiB + 16, chunkCount: 1 }))
  const nodes = blobs.map((b, i) => ({ nodeId: `n${i}`, kind: 'file', name: `v${i}`, plainSize: 20 * MiB, blobRef: { formatVersion: 2, id: b.id } }))
  const plan = planBulkDownload({ source: 'vault', items: nodes, resolve: (n) => blobs.find((b) => b.id === n.blobRef.id), fsa: false, enabled: true })
  assert.equal(plan.mode, 'refused')
  assert.equal(plan.reason, 'too-large')
})

test('NOFSA-6 backstop: a BUFFER_LIMIT overrun fails the archive, discards the parts and triggers no download', async (t) => {
  const urls = urlSpy(t)
  clicks.length = 0
  const rows = rowsOf([60, 60, 60, 60])
  const plan = filesPlan(rows)
  let sink
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: transportFor(rows).fetchStream }), busyRef: { current: false },
    createBufferedSink: () => { sink = createBufferedSink({ limitBytes: 100 }); return sink },
  })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'too-large')
  assert.deepEqual(await sink.close(), [], 'parts discarded')
  assert.equal(urls.created.length, 0)
  assert.equal(clicks.length, 0)
})

test('NOFSA-7 finalizeBufferedZip builds the Blob with the archive name and type', (t) => {
  const urls = urlSpy(t)
  clicks.length = 0
  finalizeBufferedZip([new Uint8Array([1, 2]), new Uint8Array([3])], 'a.zip', {})
  assert.equal(urls.created[0].size, 3)
  assert.equal(urls.created[0].type, 'application/zip')
  assert.equal(clicks[0].download, 'a.zip')
})
