// tests/vaultManifestStore.test.js — AEGIS Drive (IDEA1) · PR #157 Task 2.3 · immutable manifest ciphertext files
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-manifest-store-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
const { initVaultManifestStorage, writeManifestCiphertext, openManifestCiphertext, deleteManifestCiphertext, MANIFEST_DIR, ManifestStoreError } = await import('../server/storage/vaultManifestStore.js')

const bytes = (n, fill = 0x5a) => Buffer.alloc(n, fill)
const streamOf = (buf, chunk = 1024) => Readable.from((function* () { for (let i = 0; i < buf.length; i += chunk) yield buf.subarray(i, i + chunk) })())
const readAll = async (stream) => { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts) }

before(async () => { await initVaultManifestStorage() })
after(async () => { await fs.rm(STORAGE_ROOT, { recursive: true, force: true }) })

test('MS-1 write streams to STORAGE_ROOT/vault-tree/<uuid>.aegisenc with wx; returns key, size and sha256; key is opaque', async () => {
  const buf = bytes(70_000)
  const r = await writeManifestCiphertext(streamOf(buf), { limitBytes: 1 << 20 })
  assert.match(r.storageKey, /^vault-tree\/[0-9a-f-]{36}\.aegisenc$/)
  assert.equal(r.size, buf.length)
  assert.equal(r.sha256, createHash('sha256').update(buf).digest('hex'))
  const onDisk = await fs.readFile(path.join(STORAGE_ROOT, r.storageKey))
  assert.equal(onDisk.equals(buf), true)
  // write-once: the same key can never be rewritten by this module (no API takes a key to write)
  assert.equal(MANIFEST_DIR, 'vault-tree')
})

test('MS-2 over limitBytes rejects with TREE_MANIFEST_TOO_LARGE and leaves no file', async () => {
  const beforeFiles = (await fs.readdir(path.join(STORAGE_ROOT, MANIFEST_DIR))).length
  await assert.rejects(writeManifestCiphertext(streamOf(bytes(5_000)), { limitBytes: 4_096 }), (e) => e instanceof ManifestStoreError && e.code === 'TREE_MANIFEST_TOO_LARGE')
  const afterFiles = await fs.readdir(path.join(STORAGE_ROOT, MANIFEST_DIR))
  assert.equal(afterFiles.length, beforeFiles, 'partial file removed')
  assert.ok(afterFiles.every((f) => !f.includes('.tmp')))
})

test('MS-3 openManifestCiphertext streams exactly the bytes; unknown or foreign keys → null', async () => {
  const buf = bytes(12_345, 0x11)
  const { storageKey } = await writeManifestCiphertext(streamOf(buf, 100), { limitBytes: 1 << 20 })
  const back = await readAll(openManifestCiphertext(storageKey))
  assert.equal(back.equals(buf), true)
  assert.equal(openManifestCiphertext('vault-tree/does-not-exist.aegisenc'), null)
  assert.equal(openManifestCiphertext('vault/other.aegisenc'), null, 'only the manifest directory')
  assert.equal(openManifestCiphertext('../etc/passwd'), null)
  assert.equal(openManifestCiphertext(42), null)
})

test('MS-4 deleteManifestCiphertext is idempotent and scoped to the manifest directory', async () => {
  const { storageKey } = await writeManifestCiphertext(streamOf(bytes(10)), { limitBytes: 1 << 20 })
  assert.equal(await deleteManifestCiphertext(storageKey), true)
  assert.equal(await deleteManifestCiphertext(storageKey), false)
  assert.equal(openManifestCiphertext(storageKey), null)
  await assert.rejects(deleteManifestCiphertext('vault/not-a-manifest.aegisenc'), (e) => e.code === 'BAD_KEY')
})

test('MS-5 initVaultManifestStorage creates the directory under STORAGE_ROOT and probes writability', async () => {
  const r = await initVaultManifestStorage()
  assert.equal(r.root, path.join(STORAGE_ROOT, MANIFEST_DIR)); assert.equal(r.writable, true)
  const st = await fs.stat(r.root)
  assert.equal(st.isDirectory(), true)
})
