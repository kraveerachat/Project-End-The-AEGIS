// tests/mediaMotion.test.js — AEGIS Drive (IDEA1) · motion proxy generation (Task 6)
//
// ⚠️ สัญญา (spec §9, §13.5, §18): FFmpeg เท่านั้น → MP4/H.264 ≤ 480×270 (คู่), 12 fps, หน้าต่าง 6 s (-t 6.5 ฝั่ง
//    input = ขอบเขต "เวลาที่ถอดรหัส" ไม่ใช่ขอบเขตไบต์ของต้นฉบับ), ไม่มีเสียง, yuv420p, faststart, ≤ 4 MiB
//    - ภาพนิ่ง → PERMANENT NOT_ANIMATED · พิสูจน์ไม่ได้ → PERMANENT ANIMATION_UNKNOWN · ไม่มี decoder →
//      DECODER_UNAVAILABLE · ไม่มี libx264 → ENCODER_UNAVAILABLE · timeout → TRANSIENT · เกินเพดาน → OUTPUT_TOO_LARGE
//    - เขียนเฉพาะ tmpPath (Task 7 rename เข้า cache); ไม่มี child_process ตรง ๆ; ไม่มี Buffer ของต้นฉบับใน Node
//    สัญญา argument/error รันได้ทุกเครื่องด้วย runner ปลอม; ffmpeg จริงบนเครื่อง = supplemental
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { generateMotion, motionArgs, MOTION_ENCODE } from '../server/media/motion.js'
import { MediaJobError } from '../server/media/poster.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { CAPABILITIES_NONE, detectCapabilities } from '../server/media/capabilities.js'
import { createProcessRunner } from '../server/media/processRunner.js'
import { hostTools, makeFixtures } from './helpers/mediaFixtures.mjs'

const limits = mediaLimitsFromEnv({})
let dir, tools, fx
const capsFull = Object.freeze({
  ...CAPABILITIES_NONE, enabled: true, ffmpeg: { ok: true, version: '8.0' }, ffprobe: { ok: true, version: '8.0' },
  encoders: { libx264: true, libwebp: true },
  decoders: { gif: true, apng: true, webp: true, webpAnimated: true, av1: true, h264: true, vp8: true, vp9: true },
  sharp: { ok: true, version: '0.35.4', avif: true },
})
const probeOf = (over) => ({
  probeVersion: 1, family: 'gif', codec: 'gif', width: 800, height: 450, pixels: 360_000, durationSeconds: 5.7, frames: 143,
  animated: true, animationEvidence: 'gif-second-packet', posterOnly: false, unsupported: false, reason: null, engine: 'header', measuredAt: new Date().toISOString(),
  ...over,
})
let seq = 0
const tmpFor = (label) => path.join(dir, 'tmp', `${label}.motion.mp4.tmp-${(seq += 1)}`)

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-motion-'))
  await fs.mkdir(path.join(dir, 'tmp'), { recursive: true })
  tools = await hostTools()
  fx = await makeFixtures(dir, { tools })
})
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

function fakeRunner({ bytes = 4096, exitCode = 0, timedOut = false, stderr = '' } = {}) {
  const calls = []
  return {
    calls,
    async run({ bin, args, timeoutMs }) {
      calls.push({ bin, args, timeoutMs })
      const out = args[args.length - 1]
      const base = { code: 0, signal: null, stdout: '', stderr, timedOut: false, killed: false, durationMs: 1, metrics: null, stdoutTruncated: false, stderrTruncated: false }
      if (timedOut) { await fs.writeFile(out, 'partial'); return { ...base, code: null, signal: 'SIGKILL', timedOut: true, killed: true } }
      if (exitCode !== 0) { await fs.writeFile(out, 'partial'); return { ...base, code: exitCode } }
      await fs.writeFile(out, Buffer.alloc(bytes, 7))
      return base
    },
  }
}
const gen = (opts) => generateMotion({ limits, capabilities: capsFull, runner: fakeRunner(), ...opts })
const realRunner = () => (tools.ffmpeg && tools.ffprobe ? createProcessRunner() : null)
async function ffprobeJson(runner, file) {
  const r = await runner.run({ bin: 'ffprobe', args: ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-print_format', 'json', file], timeoutMs: 30_000 })
  return JSON.parse(r.stdout)
}
async function audioStreams(runner, file) {
  const r = await runner.run({ bin: 'ffprobe', args: ['-v', 'error', '-select_streams', 'a', '-show_streams', '-print_format', 'json', file], timeoutMs: 30_000 })
  return JSON.parse(r.stdout).streams.length
}
async function moovBeforeMdat(file) {
  const fh = await fs.open(file, 'r'); const { buffer, bytesRead } = await fh.read(Buffer.alloc(65_536), 0, 65_536, 0); await fh.close()
  const head = buffer.subarray(0, bytesRead).toString('latin1')
  const moov = head.indexOf('moov'), mdat = head.indexOf('mdat')
  return moov >= 0 && (mdat < 0 || moov < mdat)
}
async function assertProxy(t, runner, file, label) {
  const info = await ffprobeJson(runner, file)
  const v = info.streams[0]
  assert.equal(v.codec_name, 'h264', `${label}: h264`)
  assert.equal(v.pix_fmt, 'yuv420p', `${label}: yuv420p`)
  assert.ok(v.width <= 480 && v.height <= 270, `${label}: ${v.width}x${v.height} inside 480x270`)
  assert.ok(v.width % 2 === 0 && v.height % 2 === 0, `${label}: even dimensions`)
  const [num, den] = v.r_frame_rate.split('/').map(Number)
  assert.ok(num / den <= 12.001, `${label}: fps ${v.r_frame_rate} ≤ 12`)
  assert.ok(Number(info.format.duration) <= 6.1, `${label}: duration ${info.format.duration} ≤ 6.1`)
  assert.equal(await audioStreams(runner, file), 0, `${label}: no audio`)
  assert.equal(await moovBeforeMdat(file), true, `${label}: moov before mdat (faststart)`)
  t.diagnostic(`HOST_FFMPEG ${label}: h264 ${v.width}x${v.height} ${v.r_frame_rate}fps ${Number(info.format.duration).toFixed(2)}s ${(await fs.stat(file)).size} bytes (supplemental)`)
}

test('MG-ARGS motionArgs is the exact single-source argument array (pure); no filter-complex threads; only absPath/tmpPath are paths', () => {
  const a = motionArgs({ absPath: '/in/anim.gif', tmpPath: '/out/t', limits })
  const W = limits.motionBox.width, H = limits.motionBox.height, fps = limits.motionFps
  assert.deepEqual(a, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
    '-threads', String(limits.decoderThreads), '-filter_threads', String(limits.filterThreads),
    '-probesize', String(limits.probesizeBytes), '-analyzeduration', '5000000',
    '-ss', '0', '-t', String(limits.motionMaxSeconds + 0.5), '-i', '/in/anim.gif',
    '-an', '-t', String(limits.motionMaxSeconds),
    '-vf', `fps=${fps},scale='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    '-c:v', 'libx264', '-threads:v', String(limits.encoderThreads), '-preset', 'veryfast', '-crf', '28', '-maxrate', '1200k', '-bufsize', '2400k', '-g', '24', '-profile:v', 'main', '-level', '3.1',
    '-movflags', '+faststart', '-f', 'mp4', '-y', '/out/t',
  ])
  assert.ok(!a.includes('-filter_complex_threads'))
  assert.equal(a.filter((x) => x.startsWith('/')).length, 2, 'exactly absPath and tmpPath are path-like')
  assert.deepEqual(MOTION_ENCODE, { preset: 'veryfast', crf: 28, maxrate: '1200k', bufsize: '2400k', gop: 24, profile: 'main', level: '3.1' })
  // -t before -i bounds the demux window (temporal), -t after -i bounds the encoded output; neither is a byte bound
  assert.ok(a.indexOf('-t') < a.indexOf('-i') && a.lastIndexOf('-t') > a.indexOf('-i'))
})

test('MG-STILL a still probe never spawns: PERMANENT / NOT_ANIMATED', async () => {
  const runner = fakeRunner()
  await assert.rejects(gen({ absPath: path.join(dir, 'still.png'), probe: probeOf({ family: 'png', animated: false, animationEvidence: 'png-no-actl' }), tmpPath: tmpFor('still'), runner }),
    (err) => err instanceof MediaJobError && err.class === 'PERMANENT' && err.reason === 'NOT_ANIMATED')
  assert.equal(runner.calls.length, 0)
})

test('MG-UNKNOWN animated=null never spawns: PERMANENT / ANIMATION_UNKNOWN', async () => {
  const runner = fakeRunner()
  await assert.rejects(gen({ absPath: path.join(dir, 'x.webp'), probe: probeOf({ family: 'webp', animated: null, animationEvidence: 'webp-vp8x-flag-pages-unproven', posterOnly: true }), tmpPath: tmpFor('unknown'), runner }),
    (err) => err instanceof MediaJobError && err.class === 'PERMANENT' && err.reason === 'ANIMATION_UNKNOWN')
  assert.equal(runner.calls.length, 0)
})

test('MG-NOX264 missing libx264 → PERMANENT / ENCODER_UNAVAILABLE without spawning; missing ffmpeg likewise', async () => {
  const runner = fakeRunner()
  await assert.rejects(gen({ absPath: path.join(dir, 'a.gif'), probe: probeOf(), tmpPath: tmpFor('nox264'), runner, capabilities: { ...capsFull, encoders: { libx264: false, libwebp: true } } }),
    (err) => err.reason === 'ENCODER_UNAVAILABLE' && err.class === 'PERMANENT')
  await assert.rejects(gen({ absPath: path.join(dir, 'a.gif'), probe: probeOf(), tmpPath: tmpFor('noff'), runner, capabilities: CAPABILITIES_NONE }),
    (err) => err.reason === 'ENCODER_UNAVAILABLE')
  assert.equal(runner.calls.length, 0)
})

test('MG-DECODER per-family decoder gate: animated WebP needs webpAnimated, AVIF needs av1, GIF gif, APNG apng, video by codec', async () => {
  const runner = fakeRunner()
  const noDec = (over) => ({ ...capsFull, decoders: { ...capsFull.decoders, ...over } })
  const expectDecoder = (family, codec, evidence, caps) => assert.rejects(
    gen({ absPath: path.join(dir, `d.${family}`), probe: probeOf({ family, codec, animated: true, animationEvidence: evidence }), tmpPath: tmpFor(`dec-${family}`), runner, capabilities: caps }),
    (err) => err.class === 'PERMANENT' && err.reason === 'DECODER_UNAVAILABLE',
  )
  await expectDecoder('webp', 'webp', 'webp-vp8x-flag-and-anmf', noDec({ webpAnimated: false }))
  await expectDecoder('avif', 'av1', 'avif-avis-sample-count', noDec({ av1: false }))
  await expectDecoder('gif', 'gif', 'gif-second-packet', noDec({ gif: false }))
  await expectDecoder('png', 'apng', 'apng-actl-before-idat', noDec({ apng: false }))
  await expectDecoder('mp4', 'h264', 'family-video', noDec({ h264: false }))
  await expectDecoder('webm', 'vp9', 'family-video', noDec({ vp9: false }))
  await expectDecoder('webm', 'vp8', 'family-video', noDec({ vp8: false }))
  assert.equal(runner.calls.length, 0, 'decoder gate precedes any spawn')
  // when the decoder exists the job runs (fake success)
  const ok = await gen({ absPath: path.join(dir, 'ok.webp'), probe: probeOf({ family: 'webp', codec: 'webp', animationEvidence: 'webp-vp8x-flag-and-anmf' }), tmpPath: tmpFor('dec-ok'), runner })
  assert.deepEqual([ok.file, ok.mime, ok.engine], ['motion.mp4', 'video/mp4', 'ffmpeg'])
  assert.equal(runner.calls.length, 1)
})

test('MG-SUCCESS fake runner: result shape, requested geometry (fit 480x270, even), fps/seconds bounded by limits, timeout from limits', async () => {
  const runner = fakeRunner({ bytes: 12_345 })
  const tmp = tmpFor('ok')
  const r = await gen({ absPath: path.join(dir, 'a.gif'), probe: probeOf({ width: 800, height: 450, durationSeconds: 30 }), tmpPath: tmp, runner })
  assert.deepEqual(r, { file: 'motion.mp4', mime: 'video/mp4', width: 480, height: 270, fps: 12, seconds: 6, bytes: 12_345, engine: 'ffmpeg' })
  assert.equal(runner.calls[0].timeoutMs, limits.motionTimeoutMs)
  assert.equal(runner.calls[0].bin, 'ffmpeg')
  assert.equal(runner.calls[0].args[runner.calls[0].args.length - 1], tmp)
  const small = await gen({ absPath: path.join(dir, 'b.gif'), probe: probeOf({ width: 100, height: 75, durationSeconds: 2.2 }), tmpPath: tmpFor('small'), runner })
  assert.deepEqual([small.width, small.height, small.seconds], [100, 74, 2.2], 'no upscale; odd height rounded down to even; seconds = min(duration, 6)')
  const tall = await gen({ absPath: path.join(dir, 'c.gif'), probe: probeOf({ width: 1080, height: 1920, durationSeconds: null }), tmpPath: tmpFor('tall'), runner })
  assert.deepEqual([tall.width, tall.height, tall.seconds], [152, 270, 6], 'portrait fits height; unknown duration → the 6 s window')
})

test('MG-CAP output above motionMaxBytes → PERMANENT / OUTPUT_TOO_LARGE, tmp removed (no retry loop for motion)', async () => {
  const capped = mediaLimitsFromEnv({ MEDIA_MOTION_MAX_BYTES: String(64 * 1024) })
  const runner = fakeRunner({ bytes: 70_000 })
  const tmp = tmpFor('cap')
  await assert.rejects(generateMotion({ absPath: path.join(dir, 'a.gif'), probe: probeOf(), tmpPath: tmp, limits: capped, capabilities: capsFull, runner }),
    (err) => err instanceof MediaJobError && err.class === 'PERMANENT' && err.reason === 'OUTPUT_TOO_LARGE' && err.detail.bytes === 70_000 && err.detail.cap === 65_536)
  assert.equal(runner.calls.length, 1, 'single encode; the cap is a hard bound, not a quality search')
  await assert.rejects(fs.access(tmp), { code: 'ENOENT' })
})

test('MG-MALFORMED non-zero ffmpeg exit → PERMANENT / ENCODE_FAILED with byte-bounded stderr, tmp removed', async () => {
  const runner = fakeRunner({ exitCode: 1, stderr: '€'.repeat(3000) })
  const tmp = tmpFor('bad')
  await assert.rejects(gen({ absPath: path.join(dir, 'bad.mp4'), probe: probeOf({ family: 'mp4', codec: 'h264', animationEvidence: 'family-video' }), tmpPath: tmp, runner }), (err) => {
    assert.equal(err.class, 'PERMANENT'); assert.equal(err.reason, 'ENCODE_FAILED')
    assert.equal(err.detail.exitCode, 1)
    assert.ok(Buffer.byteLength(err.detail.stderr, 'utf8') <= 512 && !err.detail.stderr.includes('�'))
    return true
  })
  await assert.rejects(fs.access(tmp), { code: 'ENOENT' })
  // exit 0 but nothing written → ENCODE_FAILED too (exit code alone is not success)
  const empty = { calls: [], async run({ args }) { this.calls.push(args); return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1, metrics: null } } }
  await assert.rejects(gen({ absPath: path.join(dir, 'e.gif'), probe: probeOf(), tmpPath: tmpFor('empty'), runner: empty }), (err) => err.reason === 'ENCODE_FAILED')
})

test('MG-TIMEOUT runner timeout → TRANSIENT / TIMEOUT, tmp removed', async () => {
  const runner = fakeRunner({ timedOut: true })
  const tmp = tmpFor('timeout')
  await assert.rejects(gen({ absPath: path.join(dir, 'slow.gif'), probe: probeOf(), tmpPath: tmp, runner }),
    (err) => err instanceof MediaJobError && err.class === 'TRANSIENT' && err.reason === 'TIMEOUT' && err.detail.timedOut === true)
  await assert.rejects(fs.access(tmp), { code: 'ENOENT' })
})

test('MG-ATOMIC writes only tmpPath; no cache rename/state in the module; no direct spawn or shell', async () => {
  const src = await fs.readFile(new URL('../server/media/motion.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /child_process|shell:\s*true|readFile\(/)
  assert.doesNotMatch(src, /\brename\(|writeState|writeProbe|entryDir|paths\(/)
  assert.match(src, /'-read_intervals'|motionArgs/, 'argument array centralised')
  const isolated = path.join(dir, 'iso'); await fs.mkdir(isolated, { recursive: true })
  const tmp = path.join(isolated, 'motion.mp4.tmp-x')
  const runner = fakeRunner()
  await gen({ absPath: path.join(dir, 'a.gif'), probe: probeOf(), tmpPath: tmp, runner })
  assert.deepEqual(await fs.readdir(isolated), ['motion.mp4.tmp-x'])
})

/* ── real host ffmpeg (supplemental; Linux clone has none, Windows dev host has 8.1) ── */
test('MG-GIF / MG-APNG / MG-MP4 / MG-WEBM / MG-WEBP / MG-AVIF real proxies (supplemental host ffmpeg)', async (t) => {
  const runner = realRunner()
  if (!runner) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg/ffprobe absent — real proxies not exercised'); return }
  const caps = await detectCapabilities({ runner, loadSharp: async () => { throw new Error('not needed') } })
  t.diagnostic(`host capabilities: ffmpeg ${caps.ffmpeg.version} libx264=${caps.encoders.libx264} webpAnimated=${caps.decoders.webpAnimated} (webp demuxer=${caps.demuxers.webp}) av1=${caps.decoders.av1}`)
  const cases = [
    ['multiFrameGif', 'gif', { family: 'gif', codec: 'gif', width: 64, height: 64, durationSeconds: 2, animationEvidence: 'gif-second-packet' }],
    ['apng', 'png', { family: 'png', codec: 'apng', width: 64, height: 64, durationSeconds: 1, animationEvidence: 'apng-actl-before-idat' }],
    ['mp4Faststart', 'mp4', { family: 'mp4', codec: 'h264', width: 160, height: 90, durationSeconds: 4, animationEvidence: 'family-video' }],
    ['webmWithCues', 'webm', { family: 'webm', codec: 'vp8', width: 160, height: 90, durationSeconds: 4, animationEvidence: 'family-video' }],
    ['animatedWebp', 'webp', { family: 'webp', codec: 'webp', width: 64, height: 64, durationSeconds: 1, animationEvidence: 'webp-vp8x-flag-and-anmf' }],
    ['animatedAvif', 'avif', { family: 'avif', codec: 'av1', width: 64, height: 64, durationSeconds: 1, animationEvidence: 'avif-avis-sample-count' }],
  ]
  for (const [key, ext, over] of cases) {
    if (!fx[key]?.path) { t.diagnostic(`SKIP real-fixture ${key}: ${fx[key]?.skipped}`); continue }
    const tmp = tmpFor(`real-${key}`)
    try {
      const r = await generateMotion({ absPath: fx[key].path, probe: probeOf({ ...over, animated: true }), tmpPath: tmp, limits, capabilities: caps, runner })
      assert.equal(r.engine, 'ffmpeg')
      assert.ok(r.bytes > 0 && r.bytes <= limits.motionMaxBytes)
      await assertProxy(t, runner, tmp, `${key}.${ext}`)
    } catch (err) {
      if (err instanceof MediaJobError && err.reason === 'DECODER_UNAVAILABLE') { t.diagnostic(`SKIP real ${key}: ${err.reason} on host toolchain`); continue }
      throw err
    }
  }
})

test('MG-WINDOW -t bounds the decoded window, not source bytes: high- vs low-bitrate first window recorded (supplemental, Linux metrics)', async (t) => {
  const runner = realRunner()
  if (!runner) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: host ffmpeg absent'); return }
  const mk = async (name, filter) => {
    const p = path.join(dir, name)
    const r = await runner.run({ bin: 'ffmpeg', args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', filter, '-t', '20', '-f', 'gif', p], timeoutMs: 120_000 })
    return r.code === 0 ? p : null
  }
  const high = await mk('high.gif', 'testsrc2=size=320x240:rate=15')
  const low = await mk('low.gif', 'color=c=blue:size=320x240:rate=15')
  if (!high || !low) { t.diagnostic('SUPPLEMENTAL_NOT_AVAILABLE: could not build window fixtures'); return }
  const results = {}
  for (const [label, p] of [['high', high], ['low', low]]) {
    const tmp = tmpFor(`win-${label}`)
    const started = Date.now()
    const r = await generateMotion({ absPath: p, probe: probeOf({ width: 320, height: 240, durationSeconds: 20 }), tmpPath: tmp, limits, capabilities: capsFull, runner })
    const info = await ffprobeJson(runner, tmp)
    results[label] = { srcBytes: (await fs.stat(p)).size, outBytes: r.bytes, seconds: Number(info.format.duration), ms: Date.now() - started }
    assert.ok(results[label].seconds <= 6.1, `${label}: proxy ≤ 6.1 s from a 20 s source`)
  }
  t.diagnostic(`MG-WINDOW high: src ${results.high.srcBytes} B → proxy ${results.high.outBytes} B ${results.high.seconds.toFixed(2)}s in ${results.high.ms} ms; low: src ${results.low.srcBytes} B → proxy ${results.low.outBytes} B ${results.low.seconds.toFixed(2)}s in ${results.low.ms} ms; source read bytes: ${process.platform === 'linux' ? 'see runner metrics on the Linux gate' : 'n/a on this platform (no /proc)'}`)
})
