// tests/previewAudio.test.js — AEGIS Drive (IDEA1) · Unified Preview P1 · T-AUDIO (Normal Files)
//
// MP3 is required; other audio formats by browser capability (canPlayType). Audio never becomes a tile
// media request (the grid keeps image/video only), and the native <audio> element keeps its own keyboard
// controls. A failure is announced and Download stays enabled.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { makeT } from '../src/lib/strings.js'
import { resolveCapability, previewKindOf, previewModeOf, AUDIO_MIME_BY_FORMAT } from '../src/lib/preview/registry.js'
import { detectFormat } from '../src/lib/preview/formats.js'
import { previewKindFor, filesPreviewCapability, previewPathFor } from '../src/lib/filesView.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')
const PLAY_ALL = Object.freeze({ canPlay: Object.freeze(Object.fromEntries(Object.values(AUDIO_MIME_BY_FORMAT).map((m) => [m, true]))) })
const PLAY_NONE = Object.freeze({ canPlay: Object.freeze({}) })
const cap = (name, env, context = 'files') => resolveCapability({ ...detectFormat({ name }), size: 1 }, context, env)

test('AU-1 registry: mp3 → audio-native when the browser can play audio/mpeg, else unsupported-codec (Download stays)', () => {
  const ok = cap('song.MP3', { canPlay: { 'audio/mpeg': true } })
  assert.deepEqual({ provider: ok.provider, state: ok.state, family: ok.family, tile: ok.tile, download: ok.download }, { provider: 'audio-native', state: 'available', family: 'audio', tile: 'icon', download: true })
  const no = cap('song.mp3', PLAY_NONE)
  assert.deepEqual({ provider: no.provider, state: no.state, download: no.download, reason: no.reason }, { provider: 'audio-native', state: 'unsupported-codec', download: true, reason: 'CODEC' })
  assert.equal(previewModeOf(ok), 'audio'); assert.equal(previewModeOf(no), null)
})

test('AU-2 capability-gated formats: m4a/aac/ogg/oga/opus/wav/flac by their own MIME; Vault the same', () => {
  const expectMime = { m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs="opus"', wav: 'audio/wav', flac: 'audio/flac' }
  for (const [ext, mime] of Object.entries(expectMime)) {
    for (const context of ['files', 'vault']) {
      assert.equal(cap(`a.${ext}`, { canPlay: { [mime]: true } }, context).state, 'available', `${context} ${ext}`)
      assert.equal(cap(`a.${ext}`, { canPlay: { 'audio/mpeg': true } }, context).state, 'unsupported-codec', `${context} ${ext} without ${mime}`)
    }
  }
})

test('AU-3 audio never changes the tile path: previewKindOf / previewKindFor stay image|video only', () => {
  assert.equal(previewKindOf(cap('song.mp3', PLAY_ALL)), null)
  assert.equal(previewKindFor({ id: '1', name: 'song.mp3', kind: 'file', size: 10 }), null, 'Files tiles issue no media-info for audio')
  assert.equal(previewKindFor({ id: '1', name: 'a.jpg', kind: 'file', size: 10 }), 'image')
  assert.equal(previewKindFor({ id: '1', name: 'a.mp4', kind: 'file', size: 10 }), 'video')
  const fc = filesPreviewCapability({ id: '1', name: 'song.MP3', kind: 'file', size: 10 }, PLAY_ALL)
  assert.equal(previewModeOf(fc), 'audio')
  assert.equal(filesPreviewCapability({ id: '1', name: 'song.mp3', kind: 'file', vault: true }, PLAY_ALL).state, 'unsupported', 'Vault rows never use the Files path')
  assert.equal(filesPreviewCapability({ id: '1', name: 'dir', kind: 'folder' }, PLAY_ALL).state, 'unsupported')
})

/* ── jsdom renderer + Files modal ──────────────────────────────────────── */

let vite, audioModule, filesModule
before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  audioModule = await vite.ssrLoadModule('/src/components/preview/providers/AudioPreview.jsx').catch((e) => ({ loadError: e }))
  filesModule = await vite.ssrLoadModule('/src/screens/Files.jsx')
})
after(async () => { await vite?.close() })

async function mount({ canPlay = () => 'maybe' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })
  w.HTMLMediaElement.prototype.canPlayType = canPlay
  w.HTMLMediaElement.prototype.load = () => {}
  w.HTMLMediaElement.prototype.pause = () => {}
  const previous = new Map()
  const globals = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }
  for (const [k, v] of Object.entries(globals)) { previous.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v }) }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(w.document.getElementById('root'))
  return {
    w,
    render: (el) => act(async () => { root.render(el) }),
    fire: (el, type) => act(async () => { el.dispatchEvent(new w.Event(type)) }),
    unmount: async () => {
      await act(async () => root.unmount())
      for (const [k, d] of previous) { if (d === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, d) }
      w.close()
    },
  }
}

test('AU-4 AudioPreview: native <audio controls preload=metadata>, labelled, phases ready / buffering / error', async () => {
  assert.equal(audioModule.loadError, undefined, String(audioModule.loadError?.message ?? ''))
  const m = await mount()
  const phases = []
  try {
    await m.render(React.createElement(audioModule.AudioPreview, { t, src: '/api/files/7/preview', fileName: 'song.mp3', onPhase: (p) => phases.push(p) }))
    const audio = document.querySelector('audio')
    assert.ok(audio)
    assert.equal(audio.hasAttribute('controls'), true)
    assert.equal(audio.getAttribute('preload'), 'metadata')
    assert.equal(audio.getAttribute('src'), '/api/files/7/preview')
    assert.equal(audio.hasAttribute('autoplay'), false, 'never autoplays')
    assert.match(audio.getAttribute('aria-label') ?? '', /song\.mp3/)
    assert.notEqual(audio.getAttribute('tabindex'), '-1', 'keyboard reachable')
    let el = audio.parentElement
    while (el && el.id !== 'root') { assert.equal(el.getAttribute('tabindex'), null, 'no wrapper steals focus'); el = el.parentElement }
    Object.defineProperty(audio, 'duration', { configurable: true, value: 125.4 })
    await m.fire(audio, 'loadedmetadata')
    assert.deepEqual(phases, ['ready'])
    assert.match(document.body.textContent, /2:05/, 'duration shown')
    await m.fire(audio, 'waiting')
    assert.equal(document.querySelector('[role="status"]')?.textContent, t('previewAudioBuffering'))
    await m.fire(audio, 'playing')
    assert.equal(document.querySelector('[role="status"]'), null, 'buffering notice clears')
    await m.fire(audio, 'error')
    assert.equal(phases.at(-1), 'failed')
  } finally { await m.unmount() }
})

test('AU-5 Files modal: song.MP3 mounts AudioPreview with the owner-only preview route; failure keeps Download enabled', async () => {
  const m = await mount({ canPlay: (type) => (type === 'audio/mpeg' ? 'probably' : '') })
  const file = { id: 'a1', name: 'song.MP3', kind: 'file', size: 4096, type: 'Audio' }
  let downloads = 0
  try {
    await m.render(React.createElement(filesModule.FilePreviewModal, { t, file, onClose() {}, onDownload: () => { downloads += 1 } }))
    const audio = document.querySelector('[role="dialog"] audio')
    assert.ok(audio, 'audio provider mounted')
    assert.equal(audio.getAttribute('src'), previewPathFor(file))
    assert.equal(document.querySelector('[data-preview-shell]').getAttribute('data-preview-state'), 'loading')
    await m.fire(audio, 'error')
    const body = document.querySelector('[data-preview-shell]')
    assert.equal(body.getAttribute('data-preview-state'), 'failed')
    assert.ok(body.querySelector('[role="alert"]'))
    const dl = document.querySelector('[data-preview-download]')
    assert.equal(dl.disabled, false)
    await act(async () => dl.click())
    assert.equal(downloads, 1)
  } finally { await m.unmount() }
})

test('AU-6 Files modal: a browser that cannot play the codec gets a stable unsupported message + Download, no <audio>', async () => {
  const m = await mount({ canPlay: () => '' })
  try {
    await m.render(React.createElement(filesModule.FilePreviewModal, { t, file: { id: 'a2', name: 'track.flac', kind: 'file', size: 10 }, onClose() {}, onDownload() {} }))
    assert.equal(document.querySelector('audio'), null)
    assert.equal(document.querySelector('[data-preview-shell]').getAttribute('data-preview-state'), 'unsupported')
    assert.match(document.querySelector('[data-preview-shell]').textContent, new RegExp(t('previewAudioCodecUnsupported').slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(document.querySelector('[data-preview-download]').disabled, false)
  } finally { await m.unmount() }
})
