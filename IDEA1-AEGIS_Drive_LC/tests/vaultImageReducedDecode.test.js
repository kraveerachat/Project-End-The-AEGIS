// tests/vaultImageReducedDecode.test.js — AEGIS Drive (IDEA1) · PR220-R2 C · reduced-decode camera previews
//
//   RD-FMT     codec comes from magic bytes; filename case never participates; RAW is truthfully unsupported
//   RD-PLAN    requested decode size is bounded (>= 1/8 DCT scale, poster-edge aware) and aspect preserved
//   RD-CAP     reduced lane only on the measured engine family with Worker + ImageDecoder + OffscreenCanvas
//   RD-CORE    worker core: bounded request, poster <= maxEdge, orientation via display size, cleanup in finally
//   RD-JOB     main-thread job: chunks are transferred (not retained), abort terminates the worker
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sniffImageFormat, IMAGE_FORMAT_CAPABILITIES } from '../src/lib/vaultImageFormats.js'
import {
  reducedDecodePlan, detectReducedDecodeCapability, estimateReducedDecodeReservation,
  startReducedDecodeJob, noteReducedDecodeResult, resetReducedDecodeLatchForTests,
} from '../src/lib/vaultImageReducedDecode.js'
import { runReducedDecode } from '../src/lib/vaultImageReduceCore.js'
import { syntheticJpeg, syntheticPng } from './helpers/vaultTreeFixtures.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIB = 1_048_576

/* ── formats ─────────────────────────────────────────────────────────────── */
test('RD-FMT-1 JPEG is identified by content, never by filename case', () => {
  const bytes = syntheticJpeg({ width: 6240, height: 4160 })
  assert.deepEqual(sniffImageFormat(bytes), { format: 'JPEG', mime: 'image/jpeg' })
  assert.equal(sniffImageFormat.length, 1, 'the sniffer takes bytes only — no filename argument exists')
  for (const rel of ['src/lib/vaultImageFormats.js', 'src/lib/vaultImageReducedDecode.js', 'src/lib/vaultImageReduceCore.js', 'src/lib/vaultImageThumb.js']) {
    const code = readFileSync(path.join(rootDir, rel), 'utf8').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\.(jpe?g|JPE?G)\b|endsWith\(|extname|\b(file|node|entry)\.name\b|\bfileName\b/, `${rel} has no filename/extension branch`)
  }
})

test('RD-FMT-2 registry: reduced decode only for JPEG; RAW/AVIF/HEIF never claimed', () => {
  assert.equal(IMAGE_FORMAT_CAPABILITIES.JPEG.reducedDecode, true)
  for (const f of ['PNG', 'WebP', 'GIF']) assert.equal(IMAGE_FORMAT_CAPABILITIES[f].reducedDecode, false, `${f} stays on the proven normal lane`)
  for (const f of ['AVIF', 'HEIF', 'RAW']) assert.equal(IMAGE_FORMAT_CAPABILITIES[f].preview, false, `${f} is not claimed`)
  assert.deepEqual(sniffImageFormat(syntheticPng({ width: 10, height: 10 })), { format: 'PNG', mime: 'image/png' })
  // TIFF-container camera RAW (CR2/NEF/ARW/DNG) and Fuji RAF are recognised only to say "unsupported"
  const tiffRaw = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0x43, 0x52, 2, 0])
  assert.equal(sniffImageFormat(tiffRaw).format, 'RAW')
  const raf = new TextEncoder().encode('FUJIFILMCCD-RAW 0201FF383501')
  assert.equal(sniffImageFormat(raf).format, 'RAW')
  assert.equal(sniffImageFormat(new Uint8Array(16)), null)
})

/* ── plan ────────────────────────────────────────────────────────────────── */
test('RD-PLAN requested decode size is bounded and aspect-preserving for every camera class', () => {
  for (const [w, h] of [[6240, 4160], [8192, 5464], [9504, 6336], [11648, 8736], [14204, 10652]]) {
    const plan = reducedDecodePlan({ width: w, height: h, posterMaxEdge: 512 })
    assert.equal(plan.desiredWidth, Math.ceil(w / 8), `${w}x${h}: 1/8 DCT scale width`)
    assert.equal(plan.desiredHeight, Math.ceil(h / 8))
    assert.ok(plan.decodeBytes <= Math.ceil(w / 8) * Math.ceil(h / 8) * 4)
    assert.ok(Math.max(plan.desiredWidth, plan.desiredHeight) >= 512, 'never below the poster edge')
  }
  // small-but-over-16MP sources keep at least the poster edge
  const narrow = reducedDecodePlan({ width: 3900, height: 3000, posterMaxEdge: 512 })
  const edge = Math.max(narrow.desiredWidth, narrow.desiredHeight)
  assert.ok(edge >= 512 && edge <= 513, `poster-edge floor above the 1/8 scale (${edge})`)
})

test('RD-RESERVE reservation grows with encoded input and decode size, not source pixels * 4', () => {
  const plan = reducedDecodePlan({ width: 11648, height: 8736, posterMaxEdge: 512 })
  const r = estimateReducedDecodeReservation({ inputBytes: 26 * MIB, decodeBytes: plan.decodeBytes, posterMaxEdge: 512 })
  assert.ok(r < 11648 * 8736 * 4, 'far below the full RGBA bitmap')
  assert.ok(r <= 256 * MIB, '100 MP class fits the unchanged 256 MiB ceiling')
  assert.ok(r > 26 * MIB * 2, 'encoded input is charged')
})

/* ── capability ──────────────────────────────────────────────────────────── */
const chromium = { Worker: function W() {}, ImageDecoder: function D() {}, OffscreenCanvas: function C() {}, navigator: { userAgentData: { brands: [{ brand: 'Chromium', version: '154' }] } } }

test('RD-CAP capability requires the measured engine family and all three primitives', () => {
  resetReducedDecodeLatchForTests()
  assert.equal(detectReducedDecodeCapability(chromium).ok, true)
  assert.equal(detectReducedDecodeCapability({ ...chromium, ImageDecoder: undefined }).ok, false)
  assert.equal(detectReducedDecodeCapability({ ...chromium, Worker: undefined }).ok, false)
  assert.equal(detectReducedDecodeCapability({ ...chromium, OffscreenCanvas: undefined }).ok, false)
  const gecko = { ...chromium, navigator: { userAgent: 'Firefox/140' } }
  assert.deepEqual(detectReducedDecodeCapability(gecko), { ok: false, reason: 'ENGINE_NOT_MEASURED' })
})

test('RD-LATCH a decoder that ignored the requested size disables the reduced lane for the session', () => {
  resetReducedDecodeLatchForTests()
  noteReducedDecodeResult({ desiredWidth: 780, desiredHeight: 520, decodedWidth: 780, decodedHeight: 520 })
  assert.equal(detectReducedDecodeCapability(chromium).ok, true)
  noteReducedDecodeResult({ desiredWidth: 780, desiredHeight: 520, decodedWidth: 6240, decodedHeight: 4160 })
  assert.deepEqual(detectReducedDecodeCapability(chromium), { ok: false, reason: 'UNBOUNDED_DECODER_OBSERVED' })
  resetReducedDecodeLatchForTests()
})

/* ── worker core ─────────────────────────────────────────────────────────── */
function fakeRuntime({ coded = [780, 520], display = coded, failDraw = false, rotation = 0 } = {}) {
  const log = { decoderInit: null, frameClosed: 0, decoderClosed: 0, canvases: [], drawn: [] }
  class ImageDecoder {
    constructor(init) { log.decoderInit = init; this.init = init }
    async decode() {
      // drain the stream so the core's feeding path is exercised
      const reader = this.init.data.getReader()
      for (;;) { const { done } = await reader.read(); if (done) break }
      return { image: { codedWidth: coded[0], codedHeight: coded[1], displayWidth: display[0], displayHeight: display[1], rotation, close: () => { log.frameClosed += 1 } } }
    }
    close() { log.decoderClosed += 1 }
  }
  class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; log.canvases.push([w, h]) }
    getContext() { return { drawImage: (img, x, y, w, h) => { if (failDraw) throw new Error('draw failed'); log.drawn.push([w, h]) } } }
    async convertToBlob() { return { arrayBuffer: async () => new Uint8Array(40).buffer } }
  }
  return { log, runtime: { ImageDecoder, OffscreenCanvas } }
}

const chunksOf = (...parts) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close() } })

test('RD-CORE-1 requests the bounded size, returns a poster <= maxEdge, and closes frame + decoder', async () => {
  const { log, runtime } = fakeRuntime()
  const out = await runReducedDecode({ ...runtime, data: chunksOf(new Uint8Array(4)), mime: 'image/jpeg', desiredWidth: 780, desiredHeight: 520, maxEdge: 512 })
  assert.equal(log.decoderInit.desiredWidth, 780)
  assert.equal(log.decoderInit.desiredHeight, 520)
  assert.equal(log.decoderInit.type, 'image/jpeg')
  assert.ok(out.width <= 512 && out.height <= 512, 'poster within the edge')
  assert.deepEqual([out.decodedWidth, out.decodedHeight], [780, 520])
  assert.equal(log.frameClosed, 1)
  assert.equal(log.decoderClosed, 1)
})

test('RD-CORE-2 orientation: poster geometry follows the display (EXIF-rotated) size', async () => {
  const { runtime } = fakeRuntime({ coded: [780, 520], display: [520, 780], rotation: 90 })
  const out = await runReducedDecode({ ...runtime, data: chunksOf(new Uint8Array(4)), mime: 'image/jpeg', desiredWidth: 780, desiredHeight: 520, maxEdge: 512 })
  assert.deepEqual([out.width, out.height], [341, 512], 'portrait poster for an orientation-6 landscape frame')
})

test('RD-CORE-3 cleanup runs in finally when drawing fails', async () => {
  const { log, runtime } = fakeRuntime({ failDraw: true })
  await assert.rejects(runReducedDecode({ ...runtime, data: chunksOf(new Uint8Array(4)), mime: 'image/jpeg', desiredWidth: 780, desiredHeight: 520, maxEdge: 512 }))
  assert.equal(log.frameClosed, 1, 'frame closed')
  assert.equal(log.decoderClosed, 1, 'decoder closed')
})

/* ── main-thread job ─────────────────────────────────────────────────────── */
function fakeWorker({ reply = null } = {}) {
  const w = { posted: [], transfers: [], terminated: 0, onmessage: null, onerror: null }
  w.postMessage = (msg, transfer = []) => {
    w.posted.push(msg)
    w.transfers.push(transfer)
    if (msg.type === 'end' && reply) queueMicrotask(() => w.onmessage?.({ data: reply }))
  }
  w.terminate = () => { w.terminated += 1 }
  return w
}

test('RD-JOB-1 chunks are transferred to the worker, and the worker is terminated after the result', async () => {
  const worker = fakeWorker({ reply: { type: 'done', bytes: new Uint8Array(8).buffer, width: 512, height: 341, decodedWidth: 780, decodedHeight: 520 } })
  const job = startReducedDecodeJob({ createWorker: () => worker, mime: 'image/jpeg', desiredWidth: 780, desiredHeight: 520, maxEdge: 512 })
  const chunk = new Uint8Array(1024)
  job.push(chunk)
  assert.equal(worker.transfers[1].length, 1, 'the chunk buffer is transferred, not copied')
  job.end()
  const out = await job.result
  assert.equal(out.width, 512)
  assert.equal(worker.terminated, 1, 'worker (decoder, frames, canvas) is torn down after the result')
})

test('RD-JOB-2 abort terminates the worker immediately and rejects as AbortError', async () => {
  const worker = fakeWorker()
  const job = startReducedDecodeJob({ createWorker: () => worker, mime: 'image/jpeg', desiredWidth: 780, desiredHeight: 520, maxEdge: 512 })
  job.push(new Uint8Array(16))
  job.abort()
  await assert.rejects(job.result, (e) => e.name === 'AbortError')
  assert.equal(worker.terminated, 1)
  job.push(new Uint8Array(16))
  assert.equal(worker.posted.length, 2, 'a late chunk after abort is dropped')
})

test('RD-SEC the reduced path has no network, storage, or server derivative route', () => {
  for (const rel of ['src/lib/vaultImageReducedDecode.js', 'src/lib/vaultImageReduceCore.js', 'src/lib/vaultImageReduceWorker.js', 'src/lib/vaultImageFormats.js']) {
    const code = readFileSync(path.join(rootDir, rel), 'utf8').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|apiFetch|localStorage|sessionStorage|indexedDB|caches\.|\/api\//, `${rel} never talks to the server or persists bytes`)
  }
})

test('RD-CALIBRATE the reservation covers every measured Edge 154 production-path peak', () => {
  // [encoded bytes, width, height, measured peak process-tree delta MiB] — PR220-R2 table
  const measured = [
    [6_524_229, 6240, 4160, 41.9], [11_249_416, 8192, 5464, 51.8], [15_131_383, 9504, 6336, 56.1],
    [25_575_313, 11648, 8736, 120.7], [38_036_834, 14204, 10652, 166.3], [6_495_642, 6240, 4160, 32.3], [7_174_628, 6240, 4160, 40.6],
  ]
  for (const [input, w, h, peakMiB] of measured) {
    const plan = reducedDecodePlan({ width: w, height: h, posterMaxEdge: 512 })
    const r = estimateReducedDecodeReservation({ inputBytes: input, decodeBytes: plan.decodeBytes, posterMaxEdge: 512 })
    assert.ok(r >= peakMiB * MIB, `${w}x${h}: reservation ${(r / MIB).toFixed(1)} MiB >= measured ${peakMiB} MiB`)
    assert.ok(r <= 256 * MIB, 'within the unchanged ceiling')
  }
})
