// tests/bulkDownloadPlanWorkerStream.test.js — AEGIS Drive (IDEA1) · cross-browser streaming ZIP, plan step
//
// Root cause being fixed: Brave on Windows is a secure context without window.showSaveFilePicker, so 4+
// files above 64 MiB fell back to one-by-one downloads. Transport selection is by capability:
//   fsa            — native File System Access (unchanged)
//   worker-stream  — no FSA, but the existing same-origin Drive Service Worker can stream a download
//   buffered       — neither; the 64 MiB buffered-archive policy cap still applies unchanged
import test from 'node:test'
import assert from 'node:assert/strict'

import { planBulkDownload, zipLayout, BULK_ZIP_ENABLED, ZIP_THRESHOLD } from '../src/lib/bulkDownloadPlan.js'
import { MAX_BUFFERED_PLAINTEXT_BYTES } from '../src/lib/vaultChunkedDownload.js'

const MiB = 1024 * 1024
const NOW = new Date(2026, 9, 5, 1, 2, 3)

const rowsOf = (sizes) => sizes.map((size, i) => ({ id: `f${i}`, name: `file${i}.bin`, kind: 'file', type: 'Binary', size }))
const filesPlan = (rows, caps) => planBulkDownload({
  source: 'files', items: rows.map((r) => r.id), resolve: (id) => rows.find((r) => r.id === id) ?? null, enabled: true, now: NOW, ...caps,
})
function vaultInputs(sizes) {
  const blobs = sizes.map((s, i) => ({ id: `B${i}`, formatVersion: 2, size: s + 16, chunkCount: 1 }))
  const nodes = blobs.map((b, i) => ({ nodeId: `n${i}`, kind: 'file', name: `v${i}.bin`, plainSize: sizes[i], blobRef: { formatVersion: 2, id: b.id } }))
  return { nodes, resolve: (n) => blobs.find((b) => b.id === n.blobRef.id) ?? null }
}

test('WSPLAN-0 the safety constants are unchanged', () => {
  assert.equal(MAX_BUFFERED_PLAINTEXT_BYTES, 64 * MiB)
  assert.equal(BULK_ZIP_ENABLED, true)
  assert.equal(ZIP_THRESHOLD, 4)
})

test('WSPLAN-1 Files: no FSA + worker-stream + 4 files > 64 MiB → one ZIP over worker-stream', () => {
  const rows = rowsOf([30 * MiB, 30 * MiB, 20 * MiB, 20 * MiB])
  const plan = filesPlan(rows, { fsa: false, workerStream: true })
  assert.equal(plan.mode, 'zip')
  assert.equal(plan.transport, 'worker-stream')
  assert.equal(plan.fallbackNotice, undefined)
  assert.ok(plan.layout.total > MAX_BUFFERED_PLAINTEXT_BYTES)
  assert.equal(plan.layout.total, zipLayout(plan.entries).total)
  assert.equal(plan.suggestedName, 'AEGIS-Files-20261005-010203.zip')
})

test('WSPLAN-1b Vault: no FSA + worker-stream + 4 V2 entries > 64 MiB → one ZIP over worker-stream', () => {
  const { nodes, resolve } = vaultInputs([20 * MiB, 20 * MiB, 20 * MiB, 20 * MiB])
  const plan = planBulkDownload({ source: 'vault', items: nodes, resolve, fsa: false, workerStream: true, enabled: true, now: NOW })
  assert.equal(plan.mode, 'zip')
  assert.equal(plan.transport, 'worker-stream')
})

test('WSPLAN-1c V1 Vault restriction still wins over worker-stream', () => {
  const { nodes, resolve } = vaultInputs([1, 1, 1, 1])
  const v1 = nodes.map((n, i) => (i === 2 ? { ...n, blobRef: { ...n.blobRef, formatVersion: 1 } } : n))
  const plan = planBulkDownload({ source: 'vault', items: v1, resolve, fsa: false, workerStream: true, enabled: true })
  assert.equal(plan.mode, 'refused')
  assert.equal(plan.reason, 'v1-in-zip')
})

test('WSPLAN-2 no FSA and no worker-stream above 64 MiB: Files per-file fallback / Vault refusal unchanged', () => {
  const rows = rowsOf([40 * MiB, 30 * MiB, 1, 1])
  for (const caps of [{ fsa: false }, { fsa: false, workerStream: false }]) {
    const plan = filesPlan(rows, caps)
    assert.equal(plan.mode, 'per-file')
    assert.equal(plan.fallbackNotice, 'no-fsa-large')
  }
  const { nodes, resolve } = vaultInputs([20 * MiB, 20 * MiB, 20 * MiB, 20 * MiB])
  const vplan = planBulkDownload({ source: 'vault', items: nodes, resolve, fsa: false, workerStream: false, enabled: true })
  assert.equal(vplan.mode, 'refused')
  assert.equal(vplan.reason, 'too-large')
})

test('WSPLAN-3 FSA keeps the fsa transport even when worker-stream is also available', () => {
  const rows = rowsOf([30 * MiB, 30 * MiB, 20 * MiB, 20 * MiB])
  for (const caps of [{ fsa: true }, { fsa: true, workerStream: true }]) {
    const plan = filesPlan(rows, caps)
    assert.equal(plan.mode, 'zip')
    assert.equal(plan.transport, 'fsa')
  }
})

test('WSPLAN-4 ≤ 64 MiB without worker-stream keeps the buffered fallback', () => {
  const plan = filesPlan(rowsOf([5, 0, 300, 12]), { fsa: false, workerStream: false })
  assert.equal(plan.mode, 'zip')
  assert.equal(plan.transport, 'buffered')
})

test('WSPLAN-5 1–3 files stay per-file and folders are still skipped under worker-stream', () => {
  const rows = rowsOf([30 * MiB, 30 * MiB, 30 * MiB])
  const plan = filesPlan(rows, { fsa: false, workerStream: true })
  assert.equal(plan.mode, 'per-file')
  assert.equal(plan.fallbackNotice, undefined)
  const withFolder = [...rows, { id: 'd', name: 'dir', kind: 'folder', type: 'Folder', size: 0 }]
  const p2 = filesPlan(withFolder, { fsa: false, workerStream: true })
  assert.equal(p2.mode, 'per-file')
  assert.equal(p2.skippedFolders, 1)
})
