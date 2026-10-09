// tests/vaultAudioPreview.test.js — AEGIS Drive (IDEA1) · Unified Preview P1 · Task 6 (Vault audio)
//
// Vault audio is decrypted only in this tab: small files whole (Blob URL registered with the unlocked
// state), large V2 files through the existing range-decryption Service Worker session. The content type
// handed to either path comes from the DETECTED format (signature/extension), never the upload-time hint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { planVaultAudioPreview, openVaultAudioPreview } from '../src/lib/preview/vaultAudio.js'
import { confirmVaultRender, vaultPreviewMode, vaultRenderMime, vaultPreviewKind } from '../src/lib/preview/vaultCapability.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../src/lib/vaultTreeLimits.js'

const MIB = 1_048_576
const CAP = VAULT_TREE_CLIENT_LIMITS.audioWholeDecryptMaxBytes
const ENV = Object.freeze({ canPlay: Object.freeze({ 'audio/mpeg': true, 'audio/wav': true }) })
const ID3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, ...new Array(54).fill(0)])
const node = (name, over = {}) => ({ nodeId: 'N'.repeat(22), kind: 'file', name, mediaType: 'video/mp4', plainSize: 4096, blobRef: { formatVersion: 2, id: 'b1' }, ...over })

test('VA-1 limits: audioWholeDecryptMaxBytes = 32 MiB (provisional), textPreviewMaxBytes = 1 MiB', () => {
  assert.equal(CAP, 32 * MIB)
  assert.equal(VAULT_TREE_CLIENT_LIMITS.textPreviewMaxBytes, 1 * MIB)
})

test('VA-2 plan: whole decrypt up to the cap; larger V2 streams through the SW session; V1 above the cap is too-large', () => {
  const p = (variant, plainSize, streamSupported = true) => planVaultAudioPreview({ variant, plainSize, limits: VAULT_TREE_CLIENT_LIMITS, streamSupported })
  assert.equal(p(2, CAP), 'whole')
  assert.equal(p(2, CAP + 1), 'stream')
  assert.equal(p(2, CAP + 1, false), 'too-large', 'no Service Worker → never a whole-file fallback above the cap')
  assert.equal(p(1, CAP), 'whole')
  assert.equal(p(1, CAP + 1), 'too-large', 'V1 has no chunked range path')
  assert.equal(p(2, 0), 'whole')
})

test('VA-3 open: the SW session gets the DETECTED audio type (spy), never the lying upload hint', async () => {
  const n = node('song.mp3', { mediaType: 'video/mp4', plainSize: CAP + 10 })
  const contentType = vaultRenderMime(n, { env: ENV })
  assert.equal(contentType, 'audio/mpeg', 'from the extension (no bytes yet), not mediaType')
  const calls = []
  const res = await openVaultAudioPreview({
    variant: 2, plainSize: n.plainSize, limits: VAULT_TREE_CLIENT_LIMITS, streamSupported: true, contentType,
    openStream: async (o) => { calls.push(o); return { ok: true, token: 't1', url: '/drive/__vault-preview__/t1' } },
    readWhole: async () => { throw new Error('must not decrypt the whole file above the cap') },
  })
  assert.deepEqual(res, { path: 'stream', ok: true, token: 't1', url: '/drive/__vault-preview__/t1' })
  assert.deepEqual(calls, [{ contentType: 'audio/mpeg' }])
})

test('VA-4 open: small audio decrypts whole and is confirmed by its signature before any URL exists', async () => {
  let streams = 0
  const res = await openVaultAudioPreview({
    variant: 2, plainSize: 64, limits: VAULT_TREE_CLIENT_LIMITS, streamSupported: true, contentType: 'audio/mpeg',
    openStream: async () => { streams += 1; return { ok: true } },
    readWhole: async () => ID3,
  })
  assert.equal(res.path, 'whole'); assert.equal(res.ok, true); assert.equal(res.bytes, ID3); assert.equal(streams, 0)
  const tooBig = await openVaultAudioPreview({ variant: 1, plainSize: CAP + 1, limits: VAULT_TREE_CLIENT_LIMITS, streamSupported: true, contentType: 'audio/mpeg', openStream: async () => ({ ok: true }), readWhole: async () => ID3 })
  assert.deepEqual(tooBig, { path: 'too-large', ok: false })
  const failed = await openVaultAudioPreview({ variant: 2, plainSize: CAP + 1, limits: VAULT_TREE_CLIENT_LIMITS, streamSupported: true, contentType: 'audio/mpeg', openStream: async () => ({ ok: false, reason: 'WORKER' }), readWhole: async () => ID3 })
  assert.deepEqual(failed, { path: 'stream', ok: false, reason: 'WORKER' })
})

test('VA-5 capability + render gate: audio is a modal mode only (tiles stay image/video), confirmed from decrypted bytes', () => {
  const n = node('song.mp3')
  assert.equal(vaultPreviewMode(n, { env: ENV }), 'audio')
  assert.equal(vaultPreviewMode(n, { env: { canPlay: {} } }), null, 'browser cannot play → no Preview')
  assert.equal(vaultPreviewKind(n, { env: ENV }), null, 'tile scheduler never sees audio')
  const ok = confirmVaultRender(n, ID3, { env: ENV })
  assert.deepEqual([ok.ok, ok.kind, ok.mime], [true, 'audio', 'audio/mpeg'])
  const textAsMp3 = confirmVaultRender(n, new TextEncoder().encode('just text, not audio'), { env: ENV })
  assert.equal(textAsMp3.ok, false, 'bytes that are not audio never reach <audio>')
  const wav = confirmVaultRender(node('a.wav'), new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]), { env: ENV })
  assert.deepEqual([wav.kind, wav.mime], ['audio', 'audio/wav'])
})
