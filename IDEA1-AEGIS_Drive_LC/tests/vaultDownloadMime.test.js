// tests/vaultDownloadMime.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 review fix · spec §3.2
//
// Vault Download saves the exact original bytes as application/octet-stream — never the upload-time
// mediaType, the extension, or the detected preview format. Preview needs a render MIME; Download does not.
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { CORRECT_PASSPHRASE, serverBlob, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { startVaultScreenEnv } from './helpers/vaultScreenHarness.js'

let env
let dom
let kek
let screen

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
  kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  screen = await env.load('/src/screens/VaultTreeScreen.jsx')
})
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__ })

/** Run one download and capture every Blob handed to URL.createObjectURL plus the anchor's filename. */
async function captureDownload(run) {
  const blobs = []
  const names = []
  const originals = [globalThis.URL.createObjectURL, dom.window.URL.createObjectURL]
  const capture = (b) => { blobs.push(b); return `blob:capture/${blobs.length}` }
  globalThis.URL.createObjectURL = capture
  dom.window.URL.createObjectURL = capture
  const onClick = (e) => { const a = e.target?.closest?.('a[download]'); if (a) { names.push(a.getAttribute('download')); e.preventDefault() } }
  dom.window.document.addEventListener('click', onClick, true)
  const failures = []
  try {
    await run((code) => failures.push(code))
  } finally {
    globalThis.URL.createObjectURL = originals[0]
    dom.window.URL.createObjectURL = originals[1]
    dom.window.document.removeEventListener('click', onClick, true)
  }
  return { blobs, names, failures }
}

const bytesOf = async (blob) => new Uint8Array(await new Response(blob).arrayBuffer())

test('VD-1 V1 buffered download: octet-stream, exact bytes, manifest filename (mediaType image/png ignored)', async () => {
  const plain = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 250, 251])
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.respondBytes = async (req) => (String(req.path) === '/api/vault/blobs/77' ? { ok: true, status: 200, bytes: plain } : null)
  globalThis.__VAULT_BACKEND__ = backend
  const node = { nodeId: 'N'.repeat(22), kind: 'file', name: 'holiday photo.png', mediaType: 'image/png', plainSize: plain.length, blobRef: { formatVersion: 1, id: '77' } }
  const blob = serverBlob({ id: '77', name: 'envelope.png', type: 'image/png', plainSize: plain.length })
  const { blobs, names, failures } = await captureDownload((onFailed) => screen.treeDownloadEntry({ t: (k) => k, lang: 'en', kek, node, blob, onFailed }))
  assert.deepEqual(failures, [], 'download succeeds')
  assert.equal(blobs.length, 1)
  assert.equal(blobs[0].type, 'application/octet-stream', 'saved Blob type is always octet-stream')
  assert.deepEqual([...await bytesOf(blobs[0])], [...plain], 'bytes unchanged')
  assert.deepEqual(names, ['holiday photo.png'], 'filename preserved from the manifest')
})

test('VD-2 V2 buffered download: octet-stream, exact bytes, manifest filename (mediaType video/mp4 ignored)', async () => {
  const plain = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 8, 7, 6])
  const id = 'D2'.padEnd(22, 'D')
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.respondBytes = async (req) => (String(req.path).startsWith(`/api/vault/blobs/${id}/chunks/`) ? { ok: true, bytes: plain } : null)
  globalThis.__VAULT_BACKEND__ = backend
  const node = { nodeId: 'M'.repeat(22), kind: 'file', name: 'clip.mp4', mediaType: 'video/mp4', plainSize: plain.length, blobRef: { formatVersion: 2, id } }
  const blob = serverBlobV2({ id, name: 'envelope.mp4', type: 'video/mp4', plainSize: plain.length, size: plain.length + 16 })
  const { blobs, names, failures } = await captureDownload((onFailed) => screen.treeDownloadEntry({ t: (k) => k, lang: 'en', kek, node, blob, onFailed }))
  assert.deepEqual(failures, [], 'download succeeds')
  assert.equal(blobs.length, 1)
  assert.equal(blobs[0].type, 'application/octet-stream', 'saved Blob type is always octet-stream')
  assert.deepEqual([...await bytesOf(blobs[0])], [...plain], 'bytes unchanged')
  assert.deepEqual(names, ['clip.mp4'], 'filename preserved from the manifest')
})

test('VD-3 a node with no mediaType still downloads as octet-stream', async () => {
  const plain = new Uint8Array([1, 2, 3])
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.respondBytes = async (req) => (String(req.path) === '/api/vault/blobs/78' ? { ok: true, status: 200, bytes: plain } : null)
  globalThis.__VAULT_BACKEND__ = backend
  const node = { nodeId: 'O'.repeat(22), kind: 'file', name: 'README', mediaType: '', plainSize: 3, blobRef: { formatVersion: 1, id: '78' } }
  const { blobs } = await captureDownload((onFailed) => screen.treeDownloadEntry({ t: (k) => k, lang: 'en', kek, node, blob: serverBlob({ id: '78', name: 'x', type: '', plainSize: 3 }), onFailed }))
  assert.equal(blobs[0].type, 'application/octet-stream')
})
