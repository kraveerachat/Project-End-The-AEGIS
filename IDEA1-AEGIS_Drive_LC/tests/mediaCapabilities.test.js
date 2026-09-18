// tests/mediaCapabilities.test.js — AEGIS Drive (IDEA1) · media toolchain capability probe + disabled service + app injection seam (Task 1)
//
// ⚠️ ไม่ต้องมี FFmpeg/Sharp บนเครื่องที่รันชุดนี้: runner และ loadSharp เป็นของปลอมที่สคริปต์ผลลัพธ์ไว้
//    สิ่งที่ตรึง: (1) การตรวจเครื่องมือไม่มีวัน reject และเครื่องมือหาย = "ลดระดับ" ไม่ใช่บูตไม่ขึ้น
//    (2) ค่าเริ่มต้นของ createApp คือ service ที่ "ปิด" อย่างซื่อสัตย์ ไม่ใช่วัตถุที่แกล้งว่ามี media
//    (3) service ที่ปิดไม่มีผลข้างเคียงใด ๆ (spec §10.4, §22; plan Task 1)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

process.env.SESSION_SECRET ??= 'test-only-session-secret-not-used-in-production'
delete process.env.DATABASE_URL

import { detectCapabilities, CAPABILITIES_NONE } from '../server/media/capabilities.js'
import { disabledMediaService } from '../server/media/disabledService.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { createApp } from '../server/app.js'

/* ── fake toolchain ──────────────────────────────────────────────────────── */
const ENCODERS_ALL = [
  'Encoders:', ' V..... libx264              libx264 H.264 / AVC', ' V..... libwebp              libwebp WebP image',
].join('\n')
const DECODERS_ALL = [
  'Decoders:', ' V....D gif                  GIF (Graphics Interchange Format)', ' V....D apng                 APNG',
  ' V....D webp                 WebP image', ' V....D av1                  Alliance for Open Media AV1',
  ' V....D h264                 H.264 / AVC', ' V....D vp8                  On2 VP8', ' V....D vp9                  Google VP9',
].join('\n')

function fakeRunner(script) {
  const calls = []
  return {
    calls,
    async run({ bin, args }) {
      calls.push({ bin, args })
      const key = `${bin} ${args.join(' ')}`
      const hit = script.find(([matcher]) => (typeof matcher === 'string' ? key.startsWith(matcher) : matcher.test(key)))
      if (!hit) throw new Error(`unscripted: ${key}`)
      const out = hit[1]
      if (out instanceof Error) throw out
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1, metrics: null, ...out }
    },
  }
}
const DEMUXERS_PIPE_ONLY = 'Demuxers:\n D   webp_pipe       piped webp sequence\n D   gif             CompuServe Graphics Interchange Format (GIF)\n D   apng            Animated Portable Network Graphics'
const DEMUXERS_WITH_WEBP = DEMUXERS_PIPE_ONLY + '\n D   webp            WebP image sequence'
const fullScript = (version = '6.1.2', demuxers = DEMUXERS_WITH_WEBP) => [
  ['ffmpeg -version', { stdout: `ffmpeg version ${version} Copyright (c) 2000-2024 the FFmpeg developers` }],
  ['ffmpeg -hide_banner -encoders', { stdout: ENCODERS_ALL }],
  ['ffmpeg -hide_banner -decoders', { stdout: DECODERS_ALL }],
  ['ffmpeg -hide_banner -demuxers', { stdout: demuxers }],
  ['ffprobe -version', { stdout: `ffprobe version ${version}` }],
]
const enoent = () => Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
const sharpOk = async () => ({ default: { versions: { vips: '8.15.3', sharp: '0.33.5' }, format: { heif: { input: { file: true } } } } })

test('MC-1 all tools present → enabled, encoders/decoders true, sharp ok, no reasons', async () => {
  const runner = fakeRunner(fullScript())
  const caps = await detectCapabilities({ runner, loadSharp: sharpOk })
  assert.equal(caps.enabled, true)
  assert.equal(caps.ffmpeg.ok, true)
  assert.equal(caps.ffmpeg.version, '6.1.2')
  assert.equal(caps.ffprobe.ok, true)
  assert.deepEqual(caps.encoders, { libx264: true, libwebp: true })
  assert.deepEqual(caps.decoders, { gif: true, apng: true, webp: true, webpAnimated: true, av1: true, h264: true, vp8: true, vp9: true })
  assert.deepEqual(caps.demuxers, { webp: true })
  assert.equal(caps.sharp.ok, true)
  assert.equal(caps.sharp.version, '0.33.5')
  assert.deepEqual(caps.reasons, [])
  assert.equal(Object.isFrozen(caps), true)
})

test('MC-2 ffmpeg missing → enabled false with FFMPEG_MISSING; ffprobe still probed; sharp still ok; never rejects', async () => {
  const runner = fakeRunner([
    [/^ffmpeg /, enoent()],
    ['ffprobe -version', { stdout: 'ffprobe version 6.1.2' }],
  ])
  const caps = await detectCapabilities({ runner, loadSharp: sharpOk })
  assert.equal(caps.enabled, false)
  assert.equal(caps.ffmpeg.ok, false)
  assert.ok(caps.reasons.includes('FFMPEG_MISSING'))
  assert.equal(caps.ffprobe.ok, true, 'ffprobe is probed independently')
  assert.ok(runner.calls.some((c) => c.bin === 'ffprobe'))
  assert.equal(caps.sharp.ok, true)
})

test('MC-3 ffprobe times out → enabled false with FFPROBE_TIMEOUT', async () => {
  const runner = fakeRunner([
    ...fullScript().slice(0, 4),
    ['ffprobe -version', { code: null, signal: 'SIGKILL', timedOut: true, killed: true }],
  ])
  const caps = await detectCapabilities({ runner, loadSharp: sharpOk })
  assert.equal(caps.enabled, false)
  assert.equal(caps.ffprobe.ok, false)
  assert.ok(caps.reasons.includes('FFPROBE_TIMEOUT'))
  assert.equal(caps.ffmpeg.ok, true)
})

test('MC-4 libx264 absent → still enabled, encoders.libx264 false, ENCODER_LIBX264_MISSING', async () => {
  const runner = fakeRunner([
    ['ffmpeg -version', { stdout: 'ffmpeg version 6.1.2' }],
    ['ffmpeg -hide_banner -encoders', { stdout: 'Encoders:\n V..... libwebp              libwebp WebP image' }],
    ['ffmpeg -hide_banner -decoders', { stdout: DECODERS_ALL }],
    ['ffmpeg -hide_banner -demuxers', { stdout: DEMUXERS_WITH_WEBP }],
    ['ffprobe -version', { stdout: 'ffprobe version 6.1.2' }],
  ])
  const caps = await detectCapabilities({ runner, loadSharp: sharpOk })
  assert.equal(caps.enabled, true)
  assert.equal(caps.encoders.libx264, false)
  assert.equal(caps.encoders.libwebp, true)
  assert.ok(caps.reasons.includes('ENCODER_LIBX264_MISSING'))
})

test('MC-5 animated WebP decode requires a dedicated webp demuxer (not webp_pipe) plus the webp decoder — the version string never decides', async () => {
  // measured: an FFmpeg 8.1.1 build with only webp_pipe fails on animated WebP ("image data not found")
  const pipeOnly = await detectCapabilities({ runner: fakeRunner(fullScript('8.1.1', DEMUXERS_PIPE_ONLY)), loadSharp: sharpOk })
  assert.equal(pipeOnly.decoders.webp, true)
  assert.equal(pipeOnly.decoders.webpAnimated, false)
  assert.equal(pipeOnly.demuxers.webp, false)
  assert.ok(pipeOnly.reasons.includes('DEMUXER_WEBP_MISSING'))
  const withDemuxer = await detectCapabilities({ runner: fakeRunner(fullScript('6.1.2', DEMUXERS_WITH_WEBP)), loadSharp: sharpOk })
  assert.equal(withDemuxer.decoders.webpAnimated, true, 'demuxer evidence decides, not the version string')
  assert.ok(!withDemuxer.reasons.includes('DEMUXER_WEBP_MISSING'))
  // decoder not listed → false even with the demuxer
  const noWebp = await detectCapabilities({
    runner: fakeRunner([
      ['ffmpeg -version', { stdout: 'ffmpeg version 7.1' }],
      ['ffmpeg -hide_banner -encoders', { stdout: ENCODERS_ALL }],
      ['ffmpeg -hide_banner -decoders', { stdout: DECODERS_ALL.replace(/^ V....D webp.*$/m, '') }],
      ['ffmpeg -hide_banner -demuxers', { stdout: DEMUXERS_WITH_WEBP }],
      ['ffprobe -version', { stdout: 'ffprobe version 7.1' }],
    ]),
    loadSharp: sharpOk,
  })
  assert.equal(noWebp.decoders.webp, false)
  assert.equal(noWebp.decoders.webpAnimated, false)
  // demuxer listing unreadable → truthfully false with a reason, never a crash
  const unreadable = await detectCapabilities({ runner: fakeRunner(fullScript('8.0').filter(([m]) => m !== 'ffmpeg -hide_banner -demuxers')), loadSharp: sharpOk })
  assert.equal(unreadable.decoders.webpAnimated, false)
  assert.ok(unreadable.reasons.includes('FFMPEG_DEMUXERS_UNREADABLE'))
  assert.equal(unreadable.demuxers.webp, false)
})

test('MC-6 sharp import throws → sharp.ok false, SHARP_UNAVAILABLE, enabled unaffected', async () => {
  const caps = await detectCapabilities({
    runner: fakeRunner(fullScript()),
    loadSharp: async () => { throw new Error("Could not load the \"sharp\" module") },
  })
  assert.equal(caps.sharp.ok, false)
  assert.equal(caps.sharp.version, null)
  assert.ok(caps.reasons.includes('SHARP_UNAVAILABLE'))
  assert.equal(caps.enabled, true)
})

test('MC-7 CAPABILITIES_NONE is frozen with enabled false', () => {
  assert.equal(Object.isFrozen(CAPABILITIES_NONE), true)
  assert.equal(CAPABILITIES_NONE.enabled, false)
  assert.equal(CAPABILITIES_NONE.ffmpeg.ok, false)
  assert.equal(CAPABILITIES_NONE.ffprobe.ok, false)
  assert.equal(CAPABILITIES_NONE.sharp.ok, false)
  assert.equal(CAPABILITIES_NONE.encoders.libx264, false)
  assert.equal(CAPABILITIES_NONE.decoders.h264, false)
  assert.equal(CAPABILITIES_NONE.demuxers.webp, false)
})

/* ── app injection seam ──────────────────────────────────────────────────── */
async function withServer(app, fn) {
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('MC-8 /healthz default: media block is truthfully disabled (MEDIA_SERVICE_NOT_INJECTED); existing layers unchanged', async () => {
  const app = createApp({ env: { ...process.env } })
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/healthz`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.service, 'aegis-drive')
    assert.equal(typeof body.ok, 'boolean')
    assert.equal(typeof body.db, 'string')
    assert.deepEqual(Object.keys(body.layers).sort(), ['application', 'metadata', 'storage'])
    assert.equal(body.media.enabled, false)
    assert.equal(body.media.reason, 'MEDIA_SERVICE_NOT_INJECTED')
    assert.equal(body.media.cacheVolume, 'unknown')
  })
})

test('MC-9 createApp with an invalid MEDIA_* value throws at construction', () => {
  assert.throws(() => createApp({ env: { ...process.env, MEDIA_WORKERS: '9' } }), /MEDIA_WORKERS/)
})

test('MC-10 disabledMediaService: truthful UNSUPPORTED/MEDIA_DISABLED, object-hiding for vault/folder, no side effects', async () => {
  const cacheDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-disabled-')), 'never-created')
  const limits = mediaLimitsFromEnv({ MEDIA_ENABLED: 'false', MEDIA_CACHE_DIR: cacheDir.replace(/\\/g, '/') })
  const service = disabledMediaService(limits, 'MEDIA_DISABLED')
  const file = { id: '7', name: 'a.gif', kind: 'file', vault: false, sha256: 'ab'.repeat(32), path: 'uploads/x.bin', size: 10, ownerId: '2' }
  const vault = { ...file, id: '8', vault: true }
  const folder = { ...file, id: '9', kind: 'folder', sha256: null }
  assert.deepEqual(await service.info(file), { status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' })
  assert.deepEqual(await service.info(vault), { status: 'NOT_FOUND' })
  assert.deepEqual(await service.info(folder), { status: 'NOT_FOUND' })
  assert.deepEqual(await service.serve(file, 'poster', { v: file.sha256, p: 'v1' }), { kind: 'disabled' })
  assert.equal(await service.scheduleForFile(file, 1), false)
  const batch = await service.infoBatch([file, vault, folder])
  assert.equal(batch.get('7').status, 'UNSUPPORTED')
  assert.equal(batch.get('8').status, 'NOT_FOUND')
  assert.equal(batch.get('9').status, 'NOT_FOUND')
  await service.init(); await service.start(); await service.stop()
  await assert.rejects(fs.access(cacheDir), { code: 'ENOENT' }, 'disabled service never touches the cache directory')
  assert.equal(service.health().enabled, false)
  assert.equal(service.health().reason, 'MEDIA_DISABLED')
  assert.deepEqual(service.adminStatus(), { enabled: false, reason: 'MEDIA_DISABLED' })
})

test('MC-11 createApp({ mediaService }) injects by identity and health reports its reason', async () => {
  const limits = mediaLimitsFromEnv({ MEDIA_ENABLED: 'false' })
  const service = disabledMediaService(limits, 'MEDIA_DISABLED')
  const app = createApp({ env: { ...process.env }, mediaService: service })
  assert.equal(app.get('mediaService'), service)
  await withServer(app, async (base) => {
    const body = await (await fetch(`${base}/healthz`)).json()
    assert.equal(body.media.enabled, false)
    assert.equal(body.media.reason, 'MEDIA_DISABLED')
  })
})

test('MC-12 createApp({ mediaLimits }) uses the injected limits object by identity', () => {
  const limits = mediaLimitsFromEnv({ MEDIA_WORKERS: '2' })
  const app = createApp({ env: { ...process.env, MEDIA_WORKERS: '1' }, mediaLimits: limits })
  assert.equal(app.get('mediaLimits'), limits)
  assert.equal(app.get('mediaLimits').workers, 2)
})
