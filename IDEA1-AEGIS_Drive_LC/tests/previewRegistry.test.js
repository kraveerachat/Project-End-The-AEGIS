// tests/previewRegistry.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · T-REG-1 / T-DL-1
//
// The registry turns a detected format into a FileCapability. It is pure and account-free, and
// Download is a separate capability that no preview outcome may ever switch off.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FORMAT_IDS, detectFormat } from '../src/lib/preview/formats.js'
import * as registry from '../src/lib/preview/registry.js'
import * as envModule from '../src/lib/preview/env.js'

const resolveCapability = (...a) => registry.resolveCapability(...a)
const previewKindOf = (...a) => registry.previewKindOf(...a)
const detectPreviewEnv = (...a) => envModule.detectPreviewEnv(...a)
const ENV = Object.freeze({ canPlay: Object.freeze({}), webCodecs: { videoDecode: false, videoEncode: false, imageDecode: false }, swRange: false, webpEncode: false, engine: 'other' })
const desc = (format, extra = {}) => ({ format, basis: 'signature', ext: '', size: 1024, ...extra })
const STATES = new Set(['available', 'too-large', 'unsupported-codec', 'unsupported', 'locked', 'integrity-failed'])

test('RG-1 resolveCapability is pure and deterministic', () => {
  const d = desc('jpeg', { ext: 'jpg' })
  const first = resolveCapability(d, 'vault', ENV)
  for (let i = 0; i < 100; i++) assert.deepEqual(resolveCapability(d, 'vault', ENV), first)
  const src = ['registry.js', 'formats.js', 'env.js']
    .map((f) => fs.readFileSync(fileURLToPath(new URL(`../src/lib/preview/${f}`, import.meta.url)), 'utf8')).join('\n')
  for (const token of ['fetch(', 'localStorage', 'sessionStorage', 'indexedDB', 'caches.', 'XMLHttpRequest']) {
    assert.equal(src.includes(token), false, `preview core must not use ${token}`)
  }
})

test('RG-2 every format × context × lock state keeps download: true and a valid state', () => {
  for (const format of FORMAT_IDS) {
    for (const context of ['files', 'vault']) {
      for (const locked of [false, true]) {
        const cap = resolveCapability(desc(format, { ext: 'x' }), context, ENV, { locked })
        assert.equal(cap.download, true, `${format}/${context}/locked=${locked}`)
        assert.ok(STATES.has(cap.state), `${format} → ${cap.state}`)
        assert.ok(['thumbnail', 'poster', 'motion', 'icon'].includes(cap.tile))
      }
    }
  }
  assert.equal(resolveCapability(null, 'vault', ENV).download, true)
  assert.equal(resolveCapability(desc('jpeg'), 'vault', ENV, { integrityFailed: true }).download, true)
  assert.equal(resolveCapability(desc('jpeg'), 'vault', ENV, { integrityFailed: true }).state, 'integrity-failed')
})

test('RG-3 locked reveals nothing about the type', () => {
  const cap = resolveCapability(desc('mp4'), 'vault', ENV, { locked: true })
  assert.deepEqual({ state: cap.state, tile: cap.tile, family: cap.family, provider: cap.provider }, { state: 'locked', tile: 'icon', family: 'none', provider: null })
})

test('RG-4 Vault providers preserve today’s previewable set and gain signature-verified files', () => {
  for (const f of ['jpeg', 'png', 'webp']) assert.equal(resolveCapability(desc(f), 'vault', ENV).provider, 'image-native', f)
  for (const f of ['gif', 'apng', 'webp-animated']) assert.equal(resolveCapability(desc(f), 'vault', ENV).provider, 'animated-native', f)
  for (const f of ['mp4', 'webm', 'ogg-video']) assert.equal(resolveCapability(desc(f), 'vault', ENV).provider, 'video-native', f)
  for (const f of ['heif', 'raw', 'avif', 'bmp', 'mov', 'mkv', 'zip', 'unknown', 'pdf', 'mp3', 'text', 'cfb-legacy']) {
    const cap = resolveCapability(desc(f), 'vault', ENV)
    assert.equal(cap.state, 'unsupported', f)
    assert.equal(cap.tile, 'icon', f)
  }
})

test('RG-5 Files providers mirror the server /preview allowlist exactly', () => {
  const files = (name) => resolveCapability({ ...detectFormat({ name }), size: 1 }, 'files', ENV)
  for (const name of ['a.jpg', 'a.JPEG', 'a.png', 'a.gif', 'a.webp', 'a.avif', 'a.bmp']) assert.equal(previewKindOf(files(name)), 'image', name)
  for (const name of ['a.mp4', 'a.webm']) assert.equal(previewKindOf(files(name)), 'video', name)
  for (const name of ['a.m4v', 'a.mov', 'a.mkv', 'a.svg', 'a.pdf', 'a.mp3', 'a.heic', 'README', 'a.tar.gz']) assert.equal(previewKindOf(files(name)), null, name)
})

test('RG-6 extension-only Vault decisions require signature confirmation before rendering', () => {
  const cap = resolveCapability({ ...detectFormat({ name: 'Holiday.JPG' }), size: 1 }, 'vault', ENV)
  assert.equal(cap.state, 'available')
  assert.equal(cap.verify, 'signature')
  const verified = resolveCapability(desc('jpeg'), 'vault', ENV)
  assert.equal(verified.verify, 'none')
})

test('RG-7 tiles and kinds', () => {
  assert.equal(resolveCapability(desc('jpeg'), 'vault', ENV).tile, 'thumbnail')
  assert.equal(resolveCapability(desc('mp4'), 'vault', ENV).tile, 'poster')
  assert.equal(previewKindOf(resolveCapability(desc('gif'), 'vault', ENV)), 'image')
  assert.equal(previewKindOf(resolveCapability(desc('mp4'), 'vault', ENV)), 'video')
  assert.equal(previewKindOf(resolveCapability(desc('zip'), 'vault', ENV)), null)
  assert.equal(previewKindOf(resolveCapability(desc('mp4'), 'vault', ENV, { locked: true })), null)
})

test('RG-8 detectPreviewEnv never throws without browser APIs and returns a frozen snapshot', () => {
  const env = detectPreviewEnv({})
  assert.equal(Object.isFrozen(env), true)
  assert.equal(env.swRange, false)
  assert.equal(env.webCodecs.videoDecode, false)
  assert.equal(env.engine, 'other')
  const probed = detectPreviewEnv({ document: { createElement: () => ({ canPlayType: (t) => (t === 'audio/mpeg' ? 'probably' : '') }) }, navigator: { userAgent: 'Mozilla/5.0 Chrome/154.0 Edg/154.0' } })
  assert.equal(probed.canPlay['audio/mpeg'], true)
  assert.equal(probed.canPlay['audio/flac'], false)
  assert.equal(probed.engine, 'chromium')
  assert.doesNotThrow(() => detectPreviewEnv(undefined))
})

test('RG-9 the descriptor carries no account data; outputs are identical for any caller', () => {
  const d = desc('png')
  const a = resolveCapability(d, 'vault', ENV)
  const b = resolveCapability({ ...d, owner: 'admin', role: 'ADMIN', userId: 1 }, 'vault', ENV)
  assert.deepEqual(a, b, 'extra account-like fields are ignored')
})
