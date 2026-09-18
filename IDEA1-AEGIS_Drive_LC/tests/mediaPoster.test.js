// tests/mediaPoster.test.js — AEGIS Drive (IDEA1) · static poster generation (Task 5)
//
// ⚠️ สัญญา (spec §8, §10, §18, §22): sharp สำหรับภาพนิ่ง (jpeg/png/webp/avif), FFmpeg สำหรับ BMP /
//    เฟรมแรกของ GIF·AVIF เคลื่อนไหว / เฟรมวิดีโอ / ภาพนิ่งเมื่อ MEDIA_STILL_ENGINE=ffmpeg
//    - poster = WebP ≤ 640×360 fit-inside ไม่ขยาย, ปอก metadata, คง alpha, ≤ posterMaxBytes (retry q60 ครั้งเดียว)
//    - เขียนเฉพาะ tmpPath ที่ได้รับ ไม่ rename เข้า cache ไม่แตะต้นฉบับ (Task 7 เป็นเจ้าของ)
//    - ความล้มเหลว = MediaJobError { class, reason, detail(bounded) } และ tmp ถูกลบ
//    sharp ถูก inject (ของจริงบนเครื่องพัฒนา/Linux clone); FFmpeg ผ่าน runner ที่ inject ได้ —
//    สัญญา argument/error รันได้ทุกเครื่องด้วย runner ปลอม; ffmpeg จริงบนเครื่อง = supplemental เท่านั้น
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import realSharp from 'sharp'

import { generatePoster, MediaJobError, ffmpegPosterArgs, videoPosterSeekSeconds, POSTER_QUALITY } from '../server/media/poster.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { CAPABILITIES_NONE } from '../server/media/capabilities.js'
import { createProcessRunner } from '../server/media/processRunner.js'
import { hostTools } from './helpers/mediaFixtures.mjs'

const limits = mediaLimitsFromEnv({})
const LINUX = process.platform === 'linux'
let dir, tools
const capsFull = Object.freeze({
  ...CAPABILITIES_NONE, enabled: true, ffmpeg: { ok: true, version: '7.1' }, ffprobe: { ok: true, version: '7.1' },
  encoders: { libx264: true, libwebp: true }, sharp: { ok: true, version: '0.35.4', avif: true },
})
const probeOf = (over) => ({
  probeVersion: 1, family: 'jpeg', codec: null, width: 1920, height: 1080, pixels: 1920 * 1080, durationSeconds: null, frames: null,
  animated: false, animationEvidence: 'family-still', posterOnly: false, unsupported: false, reason: null, engine: 'header', measuredAt: new Date().toISOString(),
  ...over,
})
let seq = 0
const tmpFor = (label) => path.join(dir, 'tmp', `${label}.poster.webp.tmp-${(seq += 1)}`)

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-poster-'))
  await fs.mkdir(path.join(dir, 'tmp'), { recursive: true })
  tools = await hostTools()
})
after(async () => {
  // libvips keeps recently read files mapped in its operation cache; on Windows that blocks unlink briefly
  realSharp.cache(false)
  for (let i = 0; i < 20; i += 1) {
    try { await fs.rm(dir, { recursive: true, force: true }); return } catch (err) { if (!['EBUSY', 'EPERM'].includes(err.code)) throw err; await new Promise((r) => setTimeout(r, 100)) }
  }
})

/* ── test-local fixtures made with sharp (nothing committed) ─────────────── */
async function makeJpeg(name, width, height, opts = {}) {
  const p = path.join(dir, name)
  let img = realSharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 60 } } }).jpeg({ quality: 90 })
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation })
  await img.toFile(p)
  return p
}
async function makePng(name, width, height, { alpha = false, channels } = {}) {
  const p = path.join(dir, name)
  const bg = alpha ? { r: 10, g: 20, b: 30, alpha: 0 } : { r: 10, g: 120, b: 30 }
  await realSharp({ create: { width, height, channels: channels ?? (alpha ? 4 : 3), background: bg } }).png().toFile(p)
  return p
}
/** runner ปลอม: บันทึกอาร์กิวเมนต์ แล้ว "ผลิต" tmp ตามที่กำหนด (ไฟล์จริงจาก sharp เพื่อให้ตรวจสอบได้) */
function fakeRunner({ produce = 'webp', width = 640, height = 360, bytesTarget = null, exitCode = 0, timedOut = false, stderr = '' } = {}) {
  const calls = []
  return {
    calls,
    async run({ bin, args, timeoutMs }) {
      calls.push({ bin, args, timeoutMs })
      const outPath = args[args.length - 1]
      const base = { code: 0, signal: null, stdout: '', stderr, timedOut: false, killed: false, durationMs: 1, metrics: null, stdoutTruncated: false, stderrTruncated: false }
      if (timedOut) { await fs.writeFile(outPath, 'partial'); return { ...base, code: null, signal: 'SIGKILL', timedOut: true, killed: true } }
      if (exitCode !== 0) { await fs.writeFile(outPath, 'partial'); return { ...base, code: exitCode } }
      if (produce === 'none') return base
      let img = realSharp({ create: { width, height, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      img = produce === 'png' ? img.png() : img.webp({ quality: 80 })
      let buf = await img.toBuffer()
      if (bytesTarget && buf.length < bytesTarget) buf = Buffer.concat([buf, Buffer.alloc(bytesTarget - buf.length)]) // padding after the image data keeps it decodable
      await fs.writeFile(outPath, buf)
      return base
    },
  }
}
const gen = (opts) => generatePoster({ limits, capabilities: capsFull, runner: fakeRunner(), sharp: realSharp, ...opts })
const hostFfmpeg = () => (tools.ffmpeg ? createProcessRunner() : null)

/* ── sharp path ──────────────────────────────────────────────────────────── */
test('PG-1 still JPEG 1920x1080 → sharp → WebP 640x360, metadata stripped, under the default cap', async () => {
  const src = await makeJpeg('pg1.jpg', 1920, 1080)
  const tmp = tmpFor('pg1')
  const r = await gen({ absPath: src, probe: probeOf(), tmpPath: tmp })
  assert.deepEqual({ file: r.file, mime: r.mime, width: r.width, height: r.height, engine: r.engine }, { file: 'poster.webp', mime: 'image/webp', width: 640, height: 360, engine: 'sharp' })
  assert.equal(r.bytes, (await fs.stat(tmp)).size)
  assert.ok(r.bytes > 0 && r.bytes <= limits.posterMaxBytes, `bytes ${r.bytes}`)
  const meta = await realSharp(tmp).metadata()
  assert.equal(meta.format, 'webp')
  assert.deepEqual([meta.width, meta.height], [640, 360])
  assert.equal(meta.exif, undefined, 'no EXIF')
  assert.equal(meta.icc, undefined, 'no ICC')
  assert.equal(meta.xmp, undefined, 'no XMP')
  assert.equal(meta.orientation, undefined, 'no orientation tag')
})

test('PG-2 no upscale: 200x100 PNG stays 200x100', async () => {
  const src = await makePng('pg2.png', 200, 100)
  const r = await gen({ absPath: src, probe: probeOf({ family: 'png', width: 200, height: 100, pixels: 20_000 }), tmpPath: tmpFor('pg2') })
  assert.deepEqual([r.width, r.height, r.engine], [200, 100, 'sharp'])
})

test('PG-3 EXIF orientation 6 is applied before resize: 1920x1080 → portrait 203x360, no orientation metadata', async () => {
  const src = await makeJpeg('pg3.jpg', 1920, 1080, { orientation: 6 })
  assert.equal((await realSharp(src).metadata()).orientation, 6, 'fixture carries orientation 6')
  const tmp = tmpFor('pg3')
  const r = await gen({ absPath: src, probe: probeOf(), tmpPath: tmp })
  assert.equal(r.height, 360)
  assert.ok(Math.abs(r.width - 203) <= 2, `width ${r.width} ≈ 203`)
  assert.ok(r.width <= 640 && r.height <= 360 && r.width < r.height)
  const meta = await realSharp(tmp).metadata()
  assert.equal(meta.orientation, undefined)
  assert.deepEqual([meta.width, meta.height], [r.width, r.height])
})

test('PG-4 alpha: RGBA PNG → WebP with alpha preserved (no PNG fallback on the sharp path)', async () => {
  const src = await makePng('pg4.png', 400, 300, { alpha: true })
  const tmp = tmpFor('pg4')
  const r = await gen({ absPath: src, probe: probeOf({ family: 'png', width: 400, height: 300, pixels: 120_000 }), tmpPath: tmp })
  assert.equal(r.file, 'poster.webp')
  const meta = await realSharp(tmp).metadata()
  assert.equal(meta.format, 'webp')
  assert.equal(meta.hasAlpha, true)
})

/* ── ffmpeg path (fake runner always; real host ffmpeg supplemental) ─────── */
test('PG-5 BMP 1280x720 → ffmpeg: frames:v 1, libwebp, fit 640x360 without upscale, thread/probe/protocol controls', async (t) => {
  const runner = fakeRunner()
  const tmp = tmpFor('pg5')
  const r = await gen({ absPath: path.join(dir, 'pg5.bmp'), probe: probeOf({ family: 'bmp', width: 1280, height: 720, pixels: 921_600 }), tmpPath: tmp, runner })
  assert.equal(r.engine, 'ffmpeg')
  assert.deepEqual([r.file, r.mime, r.width, r.height], ['poster.webp', 'image/webp', 640, 360])
  assert.equal(runner.calls.length, 1)
  const a = runner.calls[0].args
  assert.equal(runner.calls[0].bin, 'ffmpeg')
  assert.equal(runner.calls[0].timeoutMs, limits.posterTimeoutMs)
  for (const flag of ['-nostdin', '-hide_banner']) assert.ok(a.includes(flag), flag)
  assert.deepEqual(a.slice(a.indexOf('-loglevel'), a.indexOf('-loglevel') + 2), ['-loglevel', 'error'])
  assert.deepEqual(a.slice(a.indexOf('-protocol_whitelist'), a.indexOf('-protocol_whitelist') + 2), ['-protocol_whitelist', 'file'])
  assert.deepEqual(a.slice(a.indexOf('-threads'), a.indexOf('-threads') + 2), ['-threads', String(limits.decoderThreads)])
  assert.deepEqual(a.slice(a.indexOf('-filter_threads'), a.indexOf('-filter_threads') + 2), ['-filter_threads', String(limits.filterThreads)])
  assert.deepEqual(a.slice(a.indexOf('-probesize'), a.indexOf('-probesize') + 2), ['-probesize', String(limits.probesizeBytes)])
  assert.deepEqual(a.slice(a.indexOf('-analyzeduration'), a.indexOf('-analyzeduration') + 2), ['-analyzeduration', '5000000'])
  assert.deepEqual(a.slice(a.indexOf('-frames:v'), a.indexOf('-frames:v') + 2), ['-frames:v', '1'])
  assert.deepEqual(a.slice(a.indexOf('-c:v'), a.indexOf('-c:v') + 2), ['-c:v', 'libwebp'])
  const vf = a[a.indexOf('-vf') + 1]
  assert.match(vf, /scale='min\(640,iw\)':'min\(360,ih\)':force_original_aspect_ratio=decrease/, 'fit inside 640x360, never enlarge')
  assert.ok(a.indexOf('-i') < a.indexOf('-frames:v'), 'input precedes output options')
  assert.equal(a[a.indexOf('-i') + 1], path.join(dir, 'pg5.bmp'))
  assert.equal(a[a.length - 1], tmp, 'output is exactly the supplied tmpPath')
  assert.ok(!a.includes('-ss') && !a.includes('-t'), 'no seek/duration for a still image')
  // supplemental: real host ffmpeg
  const real = hostFfmpeg()
  if (!real) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg absent — BMP real poster not exercised'); return }
  const bmp = path.join(dir, 'real.bmp')
  const made = await real.run({ bin: 'ffmpeg', args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=1', '-frames:v', '1', '-c:v', 'bmp', bmp], timeoutMs: 30_000 })
  if (made.code !== 0) { t.diagnostic(`SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg could not write BMP: ${made.stderr.slice(0, 80)}`); return }
  const tmp2 = tmpFor('pg5-real')
  const rr = await gen({ absPath: bmp, probe: probeOf({ family: 'bmp', width: 1280, height: 720, pixels: 921_600 }), tmpPath: tmp2, runner: real })
  const meta = await realSharp(tmp2).metadata()
  assert.deepEqual([rr.engine, meta.format, meta.width, meta.height], ['ffmpeg', 'webp', 640, 360])
  t.diagnostic(`HOST_FFMPEG BMP poster: ${meta.format} ${meta.width}x${meta.height} ${rr.bytes} bytes (supplemental)`)
})

test('PG-6 animated GIF poster → ffmpeg first frame only: -frames:v 1, no -t, no -ss', async (t) => {
  const runner = fakeRunner({ width: 640, height: 360 })
  const r = await gen({ absPath: path.join(dir, 'pg6.gif'), probe: probeOf({ family: 'gif', width: 800, height: 450, pixels: 360_000, animated: true, animationEvidence: 'gif-second-packet', frames: 143 }), tmpPath: tmpFor('pg6'), runner })
  assert.equal(r.engine, 'ffmpeg')
  const a = runner.calls[0].args
  assert.deepEqual(a.slice(a.indexOf('-frames:v'), a.indexOf('-frames:v') + 2), ['-frames:v', '1'])
  assert.ok(!a.includes('-t'), 'no motion-duration window in a poster job')
  assert.ok(!a.includes('-ss'), 'GIF poster is the first frame, not a seek')
  const real = hostFfmpeg()
  if (!real) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg absent — GIF real poster not exercised'); return }
  const gif = path.join(dir, 'real.gif')
  const made = await real.run({ bin: 'ffmpeg', args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5', '-t', '1', '-f', 'gif', gif], timeoutMs: 30_000 })
  if (made.code !== 0) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg could not write GIF'); return }
  const tmp2 = tmpFor('pg6-real')
  const rr = await gen({ absPath: gif, probe: probeOf({ family: 'gif', width: 320, height: 180, pixels: 57_600, animated: true }), tmpPath: tmp2, runner: real })
  const meta = await realSharp(tmp2).metadata()
  assert.deepEqual([rr.engine, meta.format, meta.width, meta.height, meta.pages ?? 1], ['ffmpeg', 'webp', 320, 180, 1], 'static single-frame poster, no upscale')
  t.diagnostic(`HOST_FFMPEG GIF first-frame poster: ${meta.width}x${meta.height} ${rr.bytes} bytes (supplemental)`)
})

test('PG-7 video poster seek = clamp(duration×0.05, 0.5, 3.0) never beyond duration; -ss precedes -i', async (t) => {
  assert.equal(videoPosterSeekSeconds(4), 0.5)
  assert.equal(videoPosterSeekSeconds(30), 1.5)
  assert.equal(videoPosterSeekSeconds(0.3), 0.3)
  assert.equal(videoPosterSeekSeconds(120), 3)
  assert.equal(videoPosterSeekSeconds(null), 0)
  for (const [duration, expected] of [[4, '0.5'], [30, '1.5'], [0.3, '0.3']]) {
    const runner = fakeRunner()
    await gen({ absPath: path.join(dir, 'pg7.mp4'), probe: probeOf({ family: 'mp4', codec: 'h264', width: 1920, height: 1080, durationSeconds: duration, animated: true, animationEvidence: 'family-video' }), tmpPath: tmpFor(`pg7-${duration}`), runner })
    const a = runner.calls[0].args
    assert.equal(a[a.indexOf('-ss') + 1], expected, `duration ${duration}`)
    assert.ok(a.indexOf('-ss') < a.indexOf('-i'), 'seek before decode (input option)')
    assert.deepEqual(a.slice(a.indexOf('-frames:v'), a.indexOf('-frames:v') + 2), ['-frames:v', '1'])
  }
  const real = hostFfmpeg()
  if (!real) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg absent — MP4 real poster not exercised'); return }
  const mp4 = path.join(dir, 'real.mp4')
  const made = await real.run({ bin: 'ffmpeg', args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], timeoutMs: 60_000 })
  if (made.code !== 0) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg could not write MP4 (libx264?)'); return }
  const tmp2 = tmpFor('pg7-real')
  const rr = await gen({ absPath: mp4, probe: probeOf({ family: 'mp4', codec: 'h264', width: 160, height: 90, durationSeconds: 4, animated: true }), tmpPath: tmp2, runner: real })
  const meta = await realSharp(tmp2).metadata()
  assert.deepEqual([rr.engine, meta.format, meta.width, meta.height], ['ffmpeg', 'webp', 160, 90])
  t.diagnostic(`HOST_FFMPEG MP4 poster @0.5s: ${meta.width}x${meta.height} ${rr.bytes} bytes (supplemental)`)
})

/* ── caps, failures, fallbacks ───────────────────────────────────────────── */
test('PG-8 output cap: exactly one lower-quality retry, then PERMANENT/OUTPUT_TOO_LARGE with tmp removed', async () => {
  const src = await makeJpeg('pg8.jpg', 1920, 1080)
  const capped = mediaLimitsFromEnv({ MEDIA_POSTER_MAX_BYTES: '16384' })
  // sharp wrapper: every encode deterministically writes 20000 bytes regardless of quality
  const qualities = []
  let encodes = 0
  const bigSharp = (input, opts) => {
    const inst = realSharp(input, opts)
    const origWebp = inst.webp.bind(inst)
    inst.webp = (o) => { qualities.push(o.quality); return origWebp(o) }
    const origToFile = inst.toFile.bind(inst)
    inst.toFile = async (p) => { encodes += 1; const info = await origToFile(p); const cur = await fs.readFile(p); await fs.writeFile(p, Buffer.concat([cur, Buffer.alloc(20_000 - Math.min(cur.length, 20_000))])); return { ...info, size: 20_000 } }
    return inst
  }
  const tmp = tmpFor('pg8')
  await assert.rejects(
    generatePoster({ absPath: src, probe: probeOf(), tmpPath: tmp, limits: capped, capabilities: capsFull, runner: fakeRunner(), sharp: bigSharp }),
    (err) => err instanceof MediaJobError && err.class === 'PERMANENT' && err.reason === 'OUTPUT_TOO_LARGE',
  )
  assert.equal(encodes, 2, 'first encode + exactly one retry, no third loop')
  assert.deepEqual(qualities, [POSTER_QUALITY.primary, POSTER_QUALITY.retry])
  assert.deepEqual([POSTER_QUALITY.primary, POSTER_QUALITY.retry], [80, 60])
  await assert.rejects(fs.access(tmp), { code: 'ENOENT' }, 'tmp removed')
  assert.deepEqual((await fs.readdir(path.join(dir, 'tmp'))).filter((n) => n.startsWith('pg8')), [], 'no other output left')
  // ffmpeg path: cap enforced the same way (one retry at lower quality, then fail)
  const runner = fakeRunner({ bytesTarget: 30_000 })
  const tmp2 = tmpFor('pg8-ffmpeg')
  await assert.rejects(
    generatePoster({ absPath: path.join(dir, 'x.bmp'), probe: probeOf({ family: 'bmp', width: 1280, height: 720 }), tmpPath: tmp2, limits: capped, capabilities: capsFull, runner, sharp: realSharp }),
    (err) => err instanceof MediaJobError && err.reason === 'OUTPUT_TOO_LARGE',
  )
  assert.equal(runner.calls.length, 2)
  assert.equal(runner.calls[0].args[runner.calls[0].args.indexOf('-quality') + 1], '80')
  assert.equal(runner.calls[1].args[runner.calls[1].args.indexOf('-quality') + 1], '60')
  await assert.rejects(fs.access(tmp2), { code: 'ENOENT' })
  // an ordinary poster is comfortably under the default 512 KiB cap (PG-1 measured the real size)
  const ok = await gen({ absPath: src, probe: probeOf(), tmpPath: tmpFor('pg8-ok') })
  assert.ok(ok.bytes < limits.posterMaxBytes)
})

test('PG-9 malformed bytes with a forged valid probe → PERMANENT/DECODE_FAILED, tmp removed, no raw exception', async () => {
  const bad = path.join(dir, 'pg9.jpg')
  await fs.writeFile(bad, '<html><body>not a jpeg</body></html>')
  const tmp = tmpFor('pg9')
  await assert.rejects(gen({ absPath: bad, probe: probeOf(), tmpPath: tmp }), (err) => {
    assert.ok(err instanceof MediaJobError, `got ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.class, 'PERMANENT'); assert.equal(err.reason, 'DECODE_FAILED')
    assert.ok(!JSON.stringify(err.detail ?? {}).includes('<html>'), 'no source bytes in the error')
    return true
  })
  await assert.rejects(fs.access(tmp), { code: 'ENOENT' })
  // ffmpeg path: non-zero exit → DECODE_FAILED with bounded stderr
  const runner = fakeRunner({ exitCode: 1, stderr: '€'.repeat(2000) })
  const tmp2 = tmpFor('pg9-ffmpeg')
  await assert.rejects(gen({ absPath: path.join(dir, 'x.bmp'), probe: probeOf({ family: 'bmp', width: 100, height: 100 }), tmpPath: tmp2, runner }), (err) => {
    assert.equal(err.reason, 'DECODE_FAILED'); assert.equal(err.class, 'PERMANENT')
    assert.equal(err.detail.exitCode, 1)
    assert.ok(Buffer.byteLength(err.detail.stderr, 'utf8') <= 512, 'stderr detail byte-bounded')
    assert.ok(!err.detail.stderr.includes('�'))
    return true
  })
  await assert.rejects(fs.access(tmp2), { code: 'ENOENT' })
})

test('PG-10 timeout from the runner → TRANSIENT/TIMEOUT, tmp removed (deterministic via injected runner)', async () => {
  const runner = fakeRunner({ timedOut: true })
  const tmp = tmpFor('pg10')
  await assert.rejects(gen({ absPath: path.join(dir, 'x.bmp'), probe: probeOf({ family: 'bmp', width: 100, height: 100 }), tmpPath: tmp, runner }), (err) => {
    assert.ok(err instanceof MediaJobError); assert.equal(err.class, 'TRANSIENT'); assert.equal(err.reason, 'TIMEOUT')
    assert.equal(err.detail.timedOut, true)
    return true
  })
  await assert.rejects(fs.access(tmp), { code: 'ENOENT' })
  assert.equal(runner.calls[0].timeoutMs, limits.posterTimeoutMs)
})

test('PG-11 MEDIA_STILL_ENGINE=ffmpeg routes a JPEG through ffmpeg (runtime rollback switch); output still WebP', async () => {
  const src = await makeJpeg('pg11.jpg', 640, 360)
  const ffLimits = mediaLimitsFromEnv({ MEDIA_STILL_ENGINE: 'ffmpeg' })
  const runner = fakeRunner()
  const r = await generatePoster({ absPath: src, probe: probeOf({ width: 640, height: 360 }), tmpPath: tmpFor('pg11'), limits: ffLimits, capabilities: capsFull, runner, sharp: realSharp })
  assert.equal(r.engine, 'ffmpeg')
  assert.equal(r.file, 'poster.webp')
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].args[runner.calls[0].args.indexOf('-i') + 1], src)
  // sharp unavailable at runtime (capabilities) also falls back to ffmpeg for stills
  const noSharp = { ...capsFull, sharp: { ok: false, version: null, avif: false } }
  const runner2 = fakeRunner()
  const r2 = await generatePoster({ absPath: src, probe: probeOf({ width: 640, height: 360 }), tmpPath: tmpFor('pg11b'), limits, capabilities: noSharp, runner: runner2, sharp: null })
  assert.equal(r2.engine, 'ffmpeg')
  // neither engine available → ENCODER_UNAVAILABLE
  await assert.rejects(generatePoster({ absPath: src, probe: probeOf({ width: 640, height: 360 }), tmpPath: tmpFor('pg11c'), limits, capabilities: CAPABILITIES_NONE, runner: fakeRunner(), sharp: null }), (err) => err instanceof MediaJobError && err.class === 'PERMANENT' && err.reason === 'ENCODER_UNAVAILABLE')
})

test('PG-12 libwebp absent → ffmpeg writes PNG (poster.png / image/png) with the byte cap still enforced; sharp path stays WebP', async () => {
  const noWebp = { ...capsFull, encoders: { libx264: true, libwebp: false } }
  const runner = fakeRunner({ produce: 'png' })
  const tmp = tmpFor('pg12')
  const r = await generatePoster({ absPath: path.join(dir, 'x.bmp'), probe: probeOf({ family: 'bmp', width: 1280, height: 720 }), tmpPath: tmp, limits, capabilities: noWebp, runner, sharp: realSharp })
  assert.deepEqual([r.file, r.mime, r.engine], ['poster.png', 'image/png', 'ffmpeg'])
  const a = runner.calls[0].args
  assert.deepEqual(a.slice(a.indexOf('-c:v'), a.indexOf('-c:v') + 2), ['-c:v', 'png'])
  assert.ok(!a.includes('libwebp'))
  assert.equal((await realSharp(tmp).metadata()).format, 'png')
  // cap applies to the PNG fallback too: one retry (higher compression), then OUTPUT_TOO_LARGE
  const capped = mediaLimitsFromEnv({ MEDIA_POSTER_MAX_BYTES: '16384' })
  const runner2 = fakeRunner({ produce: 'png', bytesTarget: 30_000 })
  const tmp2 = tmpFor('pg12-cap')
  await assert.rejects(generatePoster({ absPath: path.join(dir, 'x.bmp'), probe: probeOf({ family: 'bmp', width: 1280, height: 720 }), tmpPath: tmp2, limits: capped, capabilities: noWebp, runner: runner2, sharp: realSharp }), (err) => err.reason === 'OUTPUT_TOO_LARGE')
  assert.equal(runner2.calls.length, 2)
  await assert.rejects(fs.access(tmp2), { code: 'ENOENT' })
  // sharp path never depends on the ffmpeg libwebp flag
  const src = await makeJpeg('pg12.jpg', 640, 360)
  const rs = await generatePoster({ absPath: src, probe: probeOf({ width: 640, height: 360 }), tmpPath: tmpFor('pg12-sharp'), limits, capabilities: noWebp, runner: fakeRunner(), sharp: realSharp })
  assert.deepEqual([rs.file, rs.engine], ['poster.webp', 'sharp'])
})

test('PG-13 sharp per-input guards: limitInputPixels === maxSourcePixels, sequentialRead, failOn error; pipeline rotate→resize(inside,no-enlarge)→srgb→webp; no withMetadata', async () => {
  const src = await makeJpeg('pg13.jpg', 800, 600)
  const seen = { ctor: null, calls: [] }
  const spySharp = (input, opts) => {
    seen.ctor = { input, opts }
    const inst = realSharp(input, opts)
    for (const m of ['rotate', 'resize', 'toColourspace', 'webp', 'withMetadata', 'keepMetadata', 'toFile']) {
      const orig = inst[m].bind(inst)
      inst[m] = (...args) => { seen.calls.push([m, args]); return orig(...args) }
    }
    return inst
  }
  await generatePoster({ absPath: src, probe: probeOf({ width: 800, height: 600 }), tmpPath: tmpFor('pg13'), limits, capabilities: capsFull, runner: fakeRunner(), sharp: spySharp })
  assert.equal(seen.ctor.input, src)
  assert.equal(seen.ctor.opts.limitInputPixels, limits.maxSourcePixels)
  assert.equal(seen.ctor.opts.sequentialRead, true)
  assert.equal(seen.ctor.opts.failOn, 'error')
  const names = seen.calls.map(([m]) => m)
  assert.deepEqual(names, ['rotate', 'resize', 'toColourspace', 'webp', 'toFile'], 'rotate before resize; no metadata retention call')
  const resize = seen.calls.find(([m]) => m === 'resize')[1]
  assert.deepEqual(resize, [640, 360, { fit: 'inside', withoutEnlargement: true }])
  assert.deepEqual(seen.calls.find(([m]) => m === 'toColourspace')[1], ['srgb'])
  assert.deepEqual(seen.calls.find(([m]) => m === 'webp')[1], [{ quality: 80, effort: 4 }])
  // global sharp.concurrency(1) is runtime wiring (Task 7/15), not something each poster call mutates
  const src2 = await fs.readFile(new URL('../server/media/poster.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src2, /\.concurrency\(/, 'poster.js must not mutate global sharp concurrency per call')
  assert.doesNotMatch(src2, /withMetadata|keepMetadata|keepExif|keepIcc/, 'metadata is never retained')
  assert.doesNotMatch(src2, /child_process|from 'sharp'|shell:\s*true/, 'no direct spawn, no own sharp import (injected), no shell')
})

test('PG-14 dimension guard success: 12000x3000 PNG (36 MP, under 40 MP) → 640x160; RSS delta is a diagnostic only', async (t) => {
  const src = await makePng('pg14.png', 12_000, 3000)
  const before = process.memoryUsage().rss
  const r = await gen({ absPath: src, probe: probeOf({ family: 'png', width: 12_000, height: 3000, pixels: 36_000_000 }), tmpPath: tmpFor('pg14') })
  const deltaMb = ((process.memoryUsage().rss - before) / 1_048_576).toFixed(1)
  t.diagnostic(`PG-14 rss delta ${deltaMb} MiB on ${process.platform} (diagnostic only; source ${(await fs.stat(src)).size} bytes on disk — not a byte-class fixture)`)
  assert.deepEqual([r.width, r.height, r.engine], [640, 160, 'sharp'])
  assert.ok(r.bytes <= limits.posterMaxBytes)
})

test('PG-15 atomic producer contract: writes only tmpPath, no final/cache path, original untouched and read-only', async () => {
  const src = await makeJpeg('pg15.jpg', 640, 360)
  await fs.chmod(src, 0o444)
  const beforeStat = await fs.stat(src)
  const isolated = path.join(dir, 'pg15-isolated')
  await fs.mkdir(isolated, { recursive: true })
  const tmp = path.join(isolated, 'poster.webp.tmp-15')
  const finalPath = path.join(dir, 'pg15-final', 'poster.webp')
  await gen({ absPath: src, probe: probeOf({ width: 640, height: 360 }), tmpPath: tmp })
  assert.deepEqual(await fs.readdir(isolated), ['poster.webp.tmp-15'], 'exactly the supplied tmp file was written')
  await assert.rejects(fs.access(path.dirname(finalPath)), { code: 'ENOENT' }, 'no cache/final path created')
  const afterStat = await fs.stat(src)
  assert.equal(afterStat.size, beforeStat.size)
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'original bytes untouched')
  // ffmpeg path likewise writes only tmpPath
  const isolated2 = path.join(dir, 'pg15-isolated-ff')
  await fs.mkdir(isolated2, { recursive: true })
  const tmp2 = path.join(isolated2, 'poster.webp.tmp-15b')
  const runner = fakeRunner()
  await gen({ absPath: src, probe: probeOf({ family: 'bmp', width: 640, height: 360 }), tmpPath: tmp2, runner })
  assert.deepEqual(await fs.readdir(isolated2), ['poster.webp.tmp-15b'])
  assert.equal(runner.calls[0].args[runner.calls[0].args.length - 1], tmp2)
  const src2 = await fs.readFile(new URL('../server/media/poster.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src2, /\brename\(|writeState|writeProbe|entryDir|paths\(/, 'no cache rename/state in the producer')
})

test('PG-ARGS ffmpegPosterArgs is the single source of the argument array (pure)', () => {
  const a = ffmpegPosterArgs({ absPath: '/in/x.bmp', tmpPath: '/out/t', limits, encoder: 'libwebp', quality: 80, seekSeconds: 0 })
  assert.deepEqual(a, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
    '-threads', '1', '-filter_threads', '1', '-probesize', String(limits.probesizeBytes), '-analyzeduration', '5000000',
    '-i', '/in/x.bmp', '-frames:v', '1',
    '-vf', "scale='min(640,iw)':'min(360,ih)':force_original_aspect_ratio=decrease",
    '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', '-y', '/out/t',
  ])
  const v = ffmpegPosterArgs({ absPath: '/in/v.mp4', tmpPath: '/out/t', limits, encoder: 'libwebp', quality: 60, seekSeconds: 1.5 })
  assert.deepEqual(v.slice(v.indexOf('-ss'), v.indexOf('-ss') + 4), ['-ss', '1.5', '-i', '/in/v.mp4'])
  const p = ffmpegPosterArgs({ absPath: '/in/x.bmp', tmpPath: '/out/t', limits, encoder: 'png', quality: 80, seekSeconds: 0 })
  assert.deepEqual(p.slice(p.indexOf('-c:v')), ['-c:v', 'png', '-compression_level', '6', '-f', 'image2', '-y', '/out/t'])
  assert.ok(LINUX || true)
})
