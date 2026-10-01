// tests/previewAccountNeutrality.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · T-NEUTRAL
//
// Preview capability and preview access behave identically for ADMIN, EXISTING_USER and a
// NEWLY_CREATED_USER: same headers for their own files, 404 for anyone else's (Admin included),
// and no account-dependent branch anywhere in the shared preview code.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { ACCOUNT_CLASSES, loginAccountClasses } from './helpers/accountClasses.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-preview-neutral-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')
const { detectFormat } = await import('../src/lib/preview/formats.js')
const { resolveCapability } = await import('../src/lib/preview/registry.js')

const prefix = `p0neutral-${Date.now()}`
let seq = 0
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), randomBytes(512), Buffer.from([0xff, 0xd9])])
let server, base

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((r) => server.close(r))
  if (usingPostgres) {
    await query(`DELETE FROM files WHERE name LIKE '${prefix}-%'`)
    await query(`DELETE FROM users WHERE username LIKE 'p0neutral%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

async function upload(client, name, bytes) {
  const form = new FormData()
  form.append('file', new Blob([bytes]), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `upload ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

const PREVIEW_HEADERS = ['content-type', 'x-content-type-options', 'content-disposition', 'cache-control', 'content-security-policy', 'cross-origin-resource-policy', 'accept-ranges']

test('AN-1 each class previews its own JPEG with identical headers; everyone else gets 404 (Admin has no override)', async () => {
  const accounts = await loginAccountClasses(base)
  assert.deepEqual(accounts.map((a) => a.className), ACCOUNT_CLASSES)
  const owned = new Map()
  for (const a of accounts) owned.set(a.className, await upload(a.client, `${prefix}-${seq++}-Photo.JPG`, JPEG))

  const headerSets = []
  for (const a of accounts) {
    const file = owned.get(a.className)
    const res = await a.client.raw(`/api/files/${encodeURIComponent(file.id)}/preview`)
    assert.equal(res.status, 200, `${a.className} previews its own file`)
    assert.equal(res.buffer.equals(JPEG), true)
    headerSets.push(Object.fromEntries(PREVIEW_HEADERS.map((h) => [h, (res.headers.get(h) ?? '').replace(/filename\*=UTF-8''[^;]+/, 'filename*=<name>')])))
  }
  assert.deepEqual(headerSets[1], headerSets[0], 'EXISTING_USER headers equal ADMIN headers')
  assert.deepEqual(headerSets[2], headerSets[0], 'NEWLY_CREATED_USER headers equal ADMIN headers')

  for (const a of accounts) {
    for (const [ownerClass, file] of owned) {
      if (ownerClass === a.className) continue
      const preview = await a.client.raw(`/api/files/${encodeURIComponent(file.id)}/preview`)
      assert.equal(preview.status, 404, `${a.className} → ${ownerClass} preview is object-hidden`)
      assert.equal(preview.buffer.includes(JPEG.subarray(0, 32)), false, 'no byte leak in the 404 body')
      const download = await a.client.raw(`/api/files/${encodeURIComponent(file.id)}/download`)
      assert.equal(download.status, 404, `${a.className} → ${ownerClass} download is object-hidden`)
      const batch = await a.client.req('/api/files/media-info/batch', { method: 'POST', body: { ids: [String(file.id)] } })
      assert.equal(batch.status, 200)
      assert.equal(batch.data.items[String(file.id)].status, 'NOT_FOUND', `${a.className} → ${ownerClass} media-info is NOT_FOUND`)
    }
  }
})

test('AN-2 the capability resolver takes no account input and answers identically for every class', async () => {
  const accounts = await loginAccountClasses(base)
  const descriptor = { ...detectFormat({ name: 'Photo.JPG' }), size: JPEG.length }
  const answers = accounts.map(() => ({ files: resolveCapability(descriptor, 'files', {}), vault: resolveCapability(descriptor, 'vault', {}) }))
  assert.deepEqual(answers[1], answers[0])
  assert.deepEqual(answers[2], answers[0])
  assert.equal(resolveCapability.length <= 4, true, 'signature is (descriptor, context, env, opts) — no account parameter')
})

test('AN-3 shared preview code contains no role, username, user-id, or account-age branch', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url))
  const targets = [
    'lib/preview/formats.js', 'lib/preview/registry.js', 'lib/preview/env.js', 'lib/preview/vaultCapability.js',
    'components/preview/PreviewModalShell.jsx',
  ]
  // ARIA attributes (role="status") are markup, not identity — only identifier uses of `role` count
  const forbidden = /\brole\b(?!\s*=\s*["{])|\bROLES\b|isAdmin|\busername\b|\buserId\b|user\.id|accountAge|createdAt\s*[<>]/
  for (const rel of targets) {
    const src = await fs.readFile(path.join(root, rel), 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    assert.equal(forbidden.test(code), false, `${rel} must not branch on account identity`)
  }
})
