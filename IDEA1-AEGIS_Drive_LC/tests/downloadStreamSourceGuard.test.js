// tests/downloadStreamSourceGuard.test.js — AEGIS Drive (IDEA1) · cross-browser streaming ZIP, structural guards
//
//   - the worker-stream path persists nothing: no browser storage, no Cache API, no console, no Blob
//   - there is still exactly ONE Service Worker registration in the app (the existing /drive/ worker)
//   - the worker file stays thin: it wires the download protocol from src/lib and every Response it
//     constructs itself is no-store
//   - the safety constants of the buffered fallback are unchanged
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanForbidden } from './helpers/sourceScan.mjs'
import { BULK_ZIP_ENABLED, ZIP_THRESHOLD } from '../src/lib/bulkDownloadPlan.js'
import { MAX_BUFFERED_PLAINTEXT_BYTES } from '../src/lib/vaultChunkedDownload.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const STREAM_MODULES = ['src/lib/downloadStreamSession.js', 'src/lib/downloadStreamWorkerState.js']
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(p, out)
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

test('WSGUARD-1 the stream modules use no browser storage, no Cache API and no console', () => {
  for (const m of STREAM_MODULES) {
    const src = read(m)
    assert.deepEqual(scanForbidden(src), [], m)
    assert.doesNotMatch(src, /\bcaches\s*\./, m)
  }
})

test('WSGUARD-2 the stream modules never build a whole-archive Blob or read a whole body', () => {
  for (const m of STREAM_MODULES) {
    const src = stripComments(read(m))
    assert.doesNotMatch(src, /new Blob\(|arrayBuffer\(|createObjectURL/, m)
  }
})

test('WSGUARD-3 exactly one Service Worker registration exists in the app', () => {
  const hits = []
  for (const f of listFiles(path.join(ROOT, 'src'))) {
    const n = (stripComments(fs.readFileSync(f, 'utf8')).match(/serviceWorker\s*\.\s*register\s*\(|\bcontainer\.register\s*\(/g) ?? []).length
    if (n) hits.push([path.relative(ROOT, f).replace(/\\/g, '/'), n])
  }
  assert.deepEqual(hits, [['src/lib/vaultPreviewSession.js', 1]])
})

test('WSGUARD-4 the worker stays thin and wires the download protocol from src/lib', () => {
  const sw = read('src/vaultPreviewServiceWorker.js')
  assert.match(sw, /from '\.\/lib\/downloadStreamWorkerState\.js'/)
  assert.match(sw, /handleDownloadStreamFetch\(downloads, event\.request/)
  assert.match(sw, /handleDownloadStreamMessage\(downloads, msg, event\.ports, reply\)/)
  assert.match(sw, /downloads\.closeAll\(\{ source: 'vault' \}\)/, 'locking the Vault also ends Vault downloads')
  assert.doesNotMatch(stripComments(sw), /\bcaches\b|indexedDB|localStorage|sessionStorage/)
  assert.doesNotMatch(sw, /ReadableStream\(/, 'stream construction lives in src/lib, not in the worker')
})

test('WSGUARD-5 every Response the download protocol constructs is no-store', () => {
  const src = stripComments(read('src/lib/downloadStreamWorkerState.js'))
  const responses = src.match(/new Response\(/g) ?? []
  assert.equal(responses.length, 2)
  assert.equal((src.match(/'Cache-Control': 'no-store'/g) ?? []).length, 2)
})

test('WSGUARD-6 the buffered-fallback policy constants are unchanged', () => {
  assert.equal(MAX_BUFFERED_PLAINTEXT_BYTES, 64 * 1024 * 1024)
  assert.equal(BULK_ZIP_ENABLED, true)
  assert.equal(ZIP_THRESHOLD, 4)
  assert.match(read('src/lib/vaultChunkedDownload.js'), /export const MAX_BUFFERED_PLAINTEXT_BYTES = 64 \* 1024 \* 1024\r?\n/)
})
