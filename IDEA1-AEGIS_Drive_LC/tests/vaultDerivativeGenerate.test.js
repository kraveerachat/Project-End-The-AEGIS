// tests/vaultDerivativeGenerate.test.js — D-1 PR-D · Task F.1 · thumb/poster generation from the local File
//
// jsdom/Node have no canvas or media decoder, so decode/encode/video are injected doubles (env). What is proven here
// is the policy: admission limits before decode, vp1 bounds (long edge ≤ 512, ≤ 256 KiB, one lower-quality retry),
// WebP when encodable else JPEG, JPEG posters from a local object URL that is always revoked, a hard time budget,
// null (never a throw) for anything unsupported, and no network at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateThumbFromFile, generatePosterFromFile } from '../src/lib/vaultDerivativeGenerate.js'
import { fakeJpeg, fakeWebp } from './helpers/previewIndexFixture.mjs'

const KiB = 1024

function imageEnv(o = {}) {
  const calls = { decode: 0, encode: [], closed: 0 }
  const env = {
    decodeImage: o.decodeImage ?? (async () => { calls.decode++; return { width: o.srcW ?? 4000, height: o.srcH ?? 3000, close: () => { calls.closed++ } } }),
    encodeImage: async (bitmap, { width, height, mime, quality }) => {
      calls.encode.push({ width, height, mime, quality })
      if (o.encode) return o.encode({ width, height, mime, quality })
      return mime === 'image/webp' ? fakeWebp(width, height) : fakeJpeg(width, height)
    },
    canEncodeWebp: () => o.webp ?? true,
  }
  return { env, calls }
}
const jpegFile = (w = 4000, h = 3000, extra = 0) => new File([fakeJpeg(w, h, 64 + extra)], 'IMG_0001.JPG', { type: 'image/jpeg' })

test('PDG-1 image: long edge scaled to ≤ 512, WebP when encodable, bitmap closed', async () => {
  const { env, calls } = imageEnv()
  const r = await generateThumbFromFile(jpegFile(), { env })
  assert.deepEqual({ mime: r.mime, width: r.width, height: r.height }, { mime: 'image/webp', width: 512, height: 384 })
  assert.ok(r.bytes instanceof Uint8Array)
  assert.equal(calls.decode, 1)
  assert.equal(calls.closed, 1)
  assert.deepEqual(calls.encode.map((e) => e.mime), ['image/webp'])
})

test('PDG-2 image: JPEG when the environment cannot encode WebP; small images are never upscaled', async () => {
  const { env } = imageEnv({ webp: false, srcW: 300, srcH: 200 })
  const r = await generateThumbFromFile(jpegFile(300, 200), { env })
  assert.deepEqual({ mime: r.mime, width: r.width, height: r.height }, { mime: 'image/jpeg', width: 300, height: 200 })
})

test('PDG-3 image: > 256 KiB → one lower-quality retry, then null', async () => {
  let n = 0
  const big = (w, h) => new Uint8Array([...fakeJpeg(w, h), ...new Uint8Array(300 * KiB)])
  const a = imageEnv({ webp: false, encode: ({ width, height }) => (++n === 1 ? big(width, height) : fakeJpeg(width, height)) })
  const r = await generateThumbFromFile(jpegFile(), { env: a.env })
  assert.equal(r.width, 512)
  assert.equal(a.calls.encode.length, 2)
  assert.ok(a.calls.encode[1].quality < a.calls.encode[0].quality)
  const b = imageEnv({ webp: false, encode: ({ width, height }) => big(width, height) })
  assert.equal(await generateThumbFromFile(jpegFile(), { env: b.env }), null)
  assert.equal(b.calls.encode.length, 2, 'exactly one retry')
})

test('PDG-4 image: admission limits are checked from the header BEFORE any decode', async () => {
  const { env, calls } = imageEnv()
  assert.equal(await generateThumbFromFile(jpegFile(5000, 4000), { env }), null, '20 MP > imageNormalMaxDecodedPixels')
  assert.equal(await generateThumbFromFile(jpegFile(100, 100), { env, limits: { imageNormalMaxDecodedPixels: 16_000_000, imageMaxInputBytes: 10 } }), null, 'input bytes over the limit')
  assert.equal(calls.decode, 0)
})

test('PDG-5 unsupported / undecodable / SVG / HTML → null, never throws, never decodes', async () => {
  const { env, calls } = imageEnv()
  for (const f of [
    new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'], 'a.svg', { type: 'image/svg+xml' }),
    new File(['<!doctype html><html><body>hi</body></html>'], 'a.jpg', { type: 'image/jpeg' }),
    new File([new Uint8Array(64)], 'a.png', { type: 'image/png' }),
    new File([], 'empty.jpg', { type: 'image/jpeg' }),
  ]) assert.equal(await generateThumbFromFile(f, { env }), null, f.name)
  assert.equal(calls.decode, 0)
  const broken = imageEnv({ decodeImage: async () => { throw new Error('decode failed') } })
  assert.equal(await generateThumbFromFile(jpegFile(), { env: broken.env }), null)
  const wrong = imageEnv({ encode: () => new TextEncoder().encode('<svg/>'.padEnd(64, ' ')) })
  assert.equal(await generateThumbFromFile(jpegFile(), { env: wrong.env }), null, 'encoder output is re-verified (signature)')
  assert.equal(await generateThumbFromFile(null, { env }), null)
})

test('PDG-6 time budget: a hung decode → null within budgetMs and the internal signal aborts', async () => {
  let seen = null
  const { env } = imageEnv({ decodeImage: (file, { signal } = {}) => { seen = signal; return new Promise(() => {}) } })
  const t0 = Date.now()
  assert.equal(await generateThumbFromFile(jpegFile(), { env, budgetMs: 30 }), null)
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(seen?.aborted, true)
})

test('PDG-7 caller abort → null', async () => {
  const { env } = imageEnv()
  const c = new AbortController(); c.abort()
  assert.equal(await generateThumbFromFile(jpegFile(), { env, signal: c.signal }), null)
})

function videoEnv(o = {}) {
  const calls = { created: [], revoked: [], attached: 0, cleaned: 0, seek: [], draw: [] }
  const env = {
    createObjectURL: (file) => { const u = `blob:local/${calls.created.length}`; calls.created.push(u); return u },
    revokeObjectURL: (u) => calls.revoked.push(u),
    attachVideo: async ({ url }) => {
      calls.attached++
      if (o.attachFails) throw new Error('VIDEO_DECODE')
      return { element: { duration: 20, videoWidth: 1920, videoHeight: 1080 }, seekTo: async (s) => { calls.seek.push(s) }, cleanup: () => { calls.cleaned++ } }
    },
    drawFrame: async (el, { maxEdge, quality }) => {
      calls.draw.push({ maxEdge, quality })
      if (o.draw) return o.draw({ maxEdge, quality })
      return fakeJpeg(512, 288)
    },
  }
  return { env, calls }
}
const mp4 = () => new File([new Uint8Array(2048)], 'clip.mp4', { type: 'video/mp4' })

test('PDG-8 video: local object URL → seek → JPEG poster ≤ 512, URL revoked and element cleaned in finally', async () => {
  const { env, calls } = videoEnv()
  const r = await generatePosterFromFile(mp4(), { env })
  assert.deepEqual({ mime: r.mime, width: r.width, height: r.height }, { mime: 'image/jpeg', width: 512, height: 288 })
  assert.equal(calls.created.length, 1)
  assert.deepEqual(calls.revoked, calls.created)
  assert.equal(calls.cleaned, 1)
  assert.equal(calls.draw[0].maxEdge, 512)
  assert.equal(calls.seek[0], 1, 'existing poster seek policy (5% clamped to 0.5..3 s)')
})

test('PDG-9 video failures → null, URL still revoked; unsupported container creates no URL', async () => {
  for (const o of [{ attachFails: true }, { draw: () => { throw new Error('POSTER_ENCODE') } }, { draw: () => fakeJpeg(640, 360) }, { draw: () => new Uint8Array([...fakeJpeg(512, 288), ...new Uint8Array(300 * KiB)]) }]) {
    const { env, calls } = videoEnv(o)
    assert.equal(await generatePosterFromFile(mp4(), { env }), null)
    assert.deepEqual(calls.revoked, calls.created)
  }
  const { env, calls } = videoEnv()
  assert.equal(await generatePosterFromFile(new File([new Uint8Array(10)], 'a.avi', { type: 'video/x-msvideo' }), { env }), null)
  assert.equal(await generatePosterFromFile(new File(['<html>'], 'a.mp4', { type: 'text/html' }), { env }), null)
  assert.equal(calls.created.length, 0)
})

test('PDG-10 video: hung seek hits the budget → null, URL revoked', async () => {
  const { env, calls } = videoEnv()
  env.attachVideo = async () => ({ element: { duration: 20 }, seekTo: () => new Promise(() => {}), cleanup: () => { calls.cleaned++ } })
  assert.equal(await generatePosterFromFile(mp4(), { env, budgetMs: 30 }), null)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls.revoked, calls.created)
})

test('PDG-11 no network: the module imports no transport and calls no fetch', async () => {
  const src = readFileSync(new URL('../src/lib/vaultDerivativeGenerate.js', import.meta.url), 'utf8')
  for (const banned of ["from './api.js'", 'apiFetch', 'fetch(', 'XMLHttpRequest', 'vaultChunkedDownload', 'vaultPreviewSession', 'localStorage', 'sessionStorage', 'indexedDB', 'console.']) {
    assert.equal(src.includes(banned), false, banned)
  }
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => { fetched++; throw new Error('no network') }
  try {
    await generateThumbFromFile(jpegFile(), { env: imageEnv().env })
    await generatePosterFromFile(mp4(), { env: videoEnv().env })
  } finally { globalThis.fetch = realFetch }
  assert.equal(fetched, 0)
})
