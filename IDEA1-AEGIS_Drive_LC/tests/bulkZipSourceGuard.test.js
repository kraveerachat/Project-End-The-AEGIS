// tests/bulkZipSourceGuard.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Tasks 9a and 13a
//
// Structural guards for the streaming ZIP modules (spec §15, §21):
//   buffering — no whole-body read (arrayBuffer / apiFetchBytes) anywhere in the ZIP modules, and the
//               only `new Blob(` lives in the explicitly allow-listed buffered-fallback finaliser.
//   storage   — no browser storage (local/session storage, IndexedDB, Cache API) and no console output in
//               any ZIP module: plaintext names/sizes and Vault material must never persist or be logged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { finalizeBufferedZip } from '../src/lib/bulkZipDownload.js'
import { scanForbidden } from './helpers/sourceScan.mjs'

const read = (rel) => readFileSync(new URL(`../src/lib/${rel}`, import.meta.url), 'utf8')
const ZIP_MODULES = ['zipStreamWriter.js', 'bulkZipDownload.js', 'bulkDownloadPlan.js']

/** [start, end) of a top-level `function name(` body, by brace matching. */
function functionSpan(src, name) {
  const start = src.search(new RegExp(`function ${name}\\s*\\(`))
  assert.ok(start >= 0, `${name} is defined`)
  let depth = 0
  // the body opens at the first `) {` — earlier braces belong to destructured parameters
  let i = src.indexOf(') {', start) + 2
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return [start, i + 1] }
  }
  throw new Error(`unbalanced ${name}`)
}

test('GUARD-BUF-1 the buffered-fallback finaliser is exported', () => {
  assert.equal(typeof finalizeBufferedZip, 'function')
})

test('GUARD-BUF-2 no arrayBuffer( and no apiFetchBytes in the ZIP modules', () => {
  for (const m of ZIP_MODULES) {
    const src = read(m)
    assert.ok(!src.includes('arrayBuffer('), `${m} must not buffer a whole body`)
    assert.ok(!src.includes('apiFetchBytes'), `${m} must not use the buffering fetch helper`)
  }
})

test('GUARD-BUF-3 every new Blob( lies inside finalizeBufferedZip', () => {
  for (const m of ZIP_MODULES) {
    const src = read(m)
    const hits = [...src.matchAll(/new Blob\(/g)].map((x) => x.index)
    if (m !== 'bulkZipDownload.js') { assert.deepEqual(hits, [], m); continue }
    const [s, e] = functionSpan(src, 'finalizeBufferedZip')
    for (const h of hits) assert.ok(h > s && h < e, `new Blob( at ${h} is outside finalizeBufferedZip`)
  }
})

/* ── 13a storage and console ─────────────────────────────────────── */

test('GUARD-STORE-1 scanner self-check: every forbidden primitive is flagged', () => {
  for (const sample of [
    'localStorage.getItem("k")', 'window.sessionStorage.setItem(a, b)', 'indexedDB.open("db")',
    'await caches.open("c")', 'console.log(name)', 'console.warn(x)',
  ]) {
    assert.ok(scanForbidden(sample).length > 0, sample)
  }
  assert.deepEqual(scanForbidden('const storage = createBufferedSink(); log(stats)'), [])
})

test('GUARD-STORE-2 the ZIP modules use no browser storage and no console', () => {
  for (const m of ['zipEntryNames.js', ...ZIP_MODULES]) {
    assert.deepEqual(scanForbidden(read(m)), [], m)
  }
})
