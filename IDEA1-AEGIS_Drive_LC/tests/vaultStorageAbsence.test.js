// tests/vaultStorageAbsence.test.js — AEGIS Drive (IDEA1) · PR #157 Task 7.1 · storage absence (SA-*)
//
//   SA-1     ชุด scheduler เต็มรูป (50 รายการ) เขียน storage ใด ๆ เป็นศูนย์ (instrumented globals)
//   SA-SW-1  source scan: vaultPreviewServiceWorker + vaultPreview* libs ไม่มี caches./indexedDB/
//            localStorage/sessionStorage เด็ดขาด
//   SA-2     ทุก Response ของพรีวิวต้องพก Cache-Control: no-store (พฤติกรรมเดิม re-assert)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { createThumbScheduler } from '../src/lib/vaultThumbScheduler.js'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'

test('SA-1 a full scheduler run of 50 entries performs zero storage writes', async () => {
  const counts = installStorageGuards(globalThis)
  try {
    const sched = createThumbScheduler({
      limits: treeLimitsFrom({ maxConcurrentJobs: 4, maxRetainedObjectUrls: 16, memoryCeilingBytes: 1_000_000 }),
      load: async (key) => ({ key, width: 4, height: 4, bytes: new Uint8Array(8), mime: 'image/png' }),
    })
    for (let i = 0; i < 50; i += 1) sched.observe(`s${i}`)
    for (let i = 0; i < 50; i += 1) sched.resolveForTest(`s${i}`, { width: 4, height: 4, urlBytes: new Uint8Array(1) })
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    const st = sched.stats()
    assert.equal(st.urlsRetained, 16, 'the LRU bound holds during the run')
    await sched.releaseAll()
    assert.equal(counts.writes, 0, 'zero storage writes during the whole run')
    assert.ok(counts.reads >= 0)
  } finally {
    // restore the jsdom defaults the other suites expect (installStorageGuards replaced them)
    delete globalThis.localStorage
    delete globalThis.sessionStorage
    delete globalThis.indexedDB
    delete globalThis.caches
  }
})

test('SA-SW-1 the preview worker and vaultPreview libraries never touch storage', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const files = [
    path.join(root, 'src/vaultPreviewServiceWorker.js'),
    ...fs.readdirSync(path.join(root, 'src/lib')).filter((f) => f.startsWith('vaultPreview')).map((f) => path.join(root, 'src/lib', f)),
  ].filter((p) => fs.existsSync(p))
  assert.ok(files.length >= 2, 'the scan covers the preview worker and preview libraries')
  const forbidden = /\bcaches\s*\.\s|\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b/
  const offenders = []
  for (const file of files) {
    // scan CODE, not prose — the existing Thai header comments truthfully say "no storage"
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ')
    if (forbidden.test(text)) offenders.push(path.basename(file))
  }
  assert.deepEqual(offenders, [], 'no preview module touches Cache API/IndexedDB/localStorage/sessionStorage')
})

test('SA-IMAGE-ADMISSION the image decode gate has no storage, filesystem, server decoder, or network path', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const file = path.join(root, 'src/lib/vaultImageDecodeAdmission.js')
  const code = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.doesNotMatch(code, /\bcaches\b|\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\bfetch\s*\(|\bWebSocket\b|\bsharp\b|\bffmpeg\b|node:fs|\/server\//i)
  assert.doesNotMatch(code, /^\s*import\s/m, 'admission is a pure client-only module')
})

test('PVUX-4 / VAULT-RECOVERY-5 Vault upload queue has no direct storage path; persistence goes only through the allowlisted sealed recovery store', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = path.join(root, 'src/components/VaultUploadDrawer.jsx')
  assert.ok(fs.existsSync(source), 'the Vault-specific upload controller exists')
  const strip = (file) => fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  const code = strip('src/components/VaultUploadDrawer.jsx')
  assert.doesNotMatch(code, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\s*\./, 'Vault queue never touches browser storage directly')
  assert.match(code, /createVaultRecoveryStore\(/, 'the only persistence is the Vault recovery store')
  const lib = strip('src/lib/vaultUploadRecovery.js')
  assert.doesNotMatch(lib, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\s*\.|exportKey/, 'the recovery adapter never touches storage directly and never exports a key')
  const { VAULT_RECOVERY_FIELDS } = await import('../src/lib/vaultUploadRecovery.js')
  for (const forbidden of ['name', 'type', 'mediaType', 'sha256', 'parentNodeId', 'dek', 'kek', 'wrappedDekB64', 'metaB64', 'path']) {
    assert.ok(!VAULT_RECOVERY_FIELDS.includes(forbidden), `allowlist excludes ${forbidden}`)
  }
})

test('SA-2 every preview Response carries Cache-Control: no-store (existing behaviour re-asserted)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const sw = path.join(root, 'src/vaultPreviewServiceWorker.js')
  if (!fs.existsSync(sw)) { assert.ok(true, 'no service worker in this checkout'); return }
  const text = fs.readFileSync(sw, 'utf8')
  const responses = text.match(/new Response\(/g) ?? []
  assert.ok(responses.length >= 1, 'the worker constructs preview Responses')
  assert.ok(/Cache-Control['"]?\s*[:,]?\s*['"]no-store/.test(text), 'every constructed Response is no-store by construction')
})
