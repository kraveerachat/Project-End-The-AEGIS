// tests/mediaProbe.test.js — AEGIS Drive (IDEA1) · single preview allowlist + family-specific bounded media probe (Task 4)
//
// ⚠️ สองสัญญาในไฟล์เดียว:
//    (1) allowlist ของ preview มีแหล่งเดียว (config/previewMedia.js) และ "ไม่เปลี่ยน" จาก routes/api.js เดิม
//    (2) การตัดสิน "เคลื่อนไหวหรือไม่" เป็นกฎรายตระกูลที่อ่านไบต์แบบมีขอบเขต — ไม่มีกฎรวม
//        frames > 1 || duration > 0, ไม่มีการอ่านทั้งไฟล์, พิสูจน์ไม่ได้ = null = poster-only (spec §6.1)
//    กรณีที่ต้องมีเครื่องมือจริง (ffprobe/encoder บนเครื่อง) skip พร้อมเหตุผล — ชุดนี้ไม่มีวัน skip ทั้งไฟล์
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PREVIEW_MIME, PREVIEW_EXTENSIONS, previewExtForName, previewMimeForName, isPreviewableExtension } from '../server/config/previewMedia.js'
import { probeMedia, sniffFamily, probeApngAnimation, probeWebpAnimation, probeAvifAnimation, probeGifAnimation } from '../server/media/probe.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { CAPABILITIES_NONE, detectCapabilities } from '../server/media/capabilities.js'
import { createProcessRunner } from '../server/media/processRunner.js'
import { hostTools, makeFixtures, craftedPng, craftedWebp, craftedFtyp, craftedGifHeader, actl, textChunk, pngChunk } from './helpers/mediaFixtures.mjs'

const limits = mediaLimitsFromEnv({})
let dir, fx, tools, realCaps, realRunner
/** real-fixture branch guard: returns true when it can run; otherwise prints the exact reason as a TAP diagnostic */
function realCase(t, key) {
  const reason = !fx[key]?.path ? `fixture ${key}: ${fx[key]?.skipped ?? 'not generated'}` : (!realCaps.ffprobe.ok ? 'FFPROBE_NOT_ON_HOST' : null)
  if (reason) { t.diagnostic(`SKIP real-fixture ${key}: ${reason}`); return false }
  return true
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-probe-'))
  tools = await hostTools()
  fx = await makeFixtures(dir, { tools })
  realRunner = createProcessRunner()
  realCaps = tools.ffprobe ? await detectCapabilities({ runner: realRunner, loadSharp: async () => { throw new Error('SHARP_NOT_INSTALLED') } }) : CAPABILITIES_NONE
})
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

test('FP-HOST_TOOLCHAIN · report the supplemental host toolchain and fixture availability (informational, never a pass/fail)', (t) => {
  t.diagnostic(`host ffmpeg=${tools.ffmpeg ? tools.version : 'absent'} ffprobe=${tools.ffprobe} sharp=NOT_LOADED (this suite probes without sharp by design; sharp 0.35.4 is pinned in package.json)`)
  for (const [k, v] of Object.entries(fx)) t.diagnostic(`fixture ${k}: ${v.path ? `${v.bytes} bytes` : `SKIPPED ${v.skipped}`}`)
})

/* ── fake ffprobe runner (ไม่ต้องมีเครื่องมือ) ─────────────────────────────── */
function fakeFfprobe({ streams = [], format = {}, packets = null, exitCode = 0, timedOut = false, stderr = '' } = {}) {
  const calls = []
  return {
    calls,
    async run({ bin, args, timeoutMs }) {
      calls.push({ bin, args, timeoutMs })
      if (timedOut) return { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, killed: true, durationMs: timeoutMs, metrics: null, stdoutTruncated: false, stderrTruncated: false }
      if (exitCode !== 0) return { code: exitCode, signal: null, stdout: '', stderr, timedOut: false, killed: false, durationMs: 1, metrics: null, stdoutTruncated: false, stderrTruncated: false }
      const body = args.includes('-show_packets') ? { packets: packets ?? [] } : { streams, format }
      return { code: 0, signal: null, stdout: JSON.stringify(body), stderr: '', timedOut: false, killed: false, durationMs: 1, metrics: null, stdoutTruncated: false, stderrTruncated: false }
    },
  }
}
const capsWithFfprobe = Object.freeze({ ...CAPABILITIES_NONE, enabled: true, ffmpeg: { ok: true, version: '7.1' }, ffprobe: { ok: true, version: '7.1' }, decoders: { ...CAPABILITIES_NONE.decoders, gif: true, apng: true, webp: true, webpAnimated: true, av1: true, h264: true, vp8: true, vp9: true } })
async function write(name, buf) { const p = path.join(dir, name); await fs.writeFile(p, buf); return p }
const probe = (absPath, ext, opts = {}) => probeMedia({ absPath, ext, limits, capabilities: capsWithFfprobe, runner: fakeFfprobe(), ...opts })

/* ── Phase A: allowlist ───────────────────────────────────────────────────── */
test('FP-ALLOWLIST-PARITY · previewMedia.js is the exact former routes/api.js allowlist and its only source', async () => {
  const former = Object.freeze({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm',
  })
  assert.deepEqual(PREVIEW_MIME, former)
  assert.equal(Object.isFrozen(PREVIEW_MIME), true)
  assert.deepEqual([...PREVIEW_EXTENSIONS], Object.keys(former))
  assert.equal(Object.isFrozen(PREVIEW_EXTENSIONS), true)
  assert.equal(previewExtForName('A.JPG'), 'jpg')
  assert.equal(previewExtForName('README'), null)
  assert.equal(previewExtForName('x.tar.gz'), 'gz')
  assert.equal(previewExtForName(''), null)
  assert.equal(previewMimeForName('clip.MP4'), 'video/mp4')
  assert.equal(previewMimeForName('doc.pdf'), null)
  assert.equal(previewMimeForName('Makefile'), null)
  for (const ext of ['svg', 'heic', 'pdf', 'html', 'mov', 'mkv', '']) assert.equal(isPreviewableExtension(ext), false, ext)
  assert.equal(isPreviewableExtension('JPEG'), true)
  assert.equal(isPreviewableExtension('WebM'), true)
  const api = await fs.readFile(new URL('../server/routes/api.js', import.meta.url), 'utf8')
  assert.doesNotMatch(api, /const PREVIEW_MIME\s*=/, 'routes/api.js must not keep a private allowlist')
  assert.match(api, /from '\.\.\/config\/previewMedia\.js'/, 'routes/api.js imports the shared allowlist')
  const probeSrc = await fs.readFile(new URL('../server/media/probe.js', import.meta.url), 'utf8')
  assert.match(probeSrc, /from '\.\.\/config\/previewMedia\.js'/)
  assert.doesNotMatch(probeSrc, /routes\/api\.js/, 'probe never imports the route module')
})

/* ── sniffing ─────────────────────────────────────────────────────────────── */
test('FP-SNIFF · byte families from bounded headers; a PNG named .jpg is a mismatch, never trusted by extension', async (t) => {
  assert.equal(sniffFamily(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])), 'jpeg')
  assert.equal(sniffFamily(craftedPng()), 'png')
  assert.equal(sniffFamily(craftedWebp()), 'webp')
  assert.equal(sniffFamily(Buffer.from('GIF89a\0\0\0\0')), 'gif')
  assert.equal(sniffFamily(Buffer.from('GIF87a\0\0\0\0')), 'gif')
  assert.equal(sniffFamily(Buffer.from('BM\0\0\0\0\0\0')), 'bmp')
  assert.equal(sniffFamily(craftedFtyp('avif', ['mif1', 'miaf'])), 'avif')
  assert.equal(sniffFamily(craftedFtyp('avis', ['avif', 'msf1'])), 'avif')
  assert.equal(sniffFamily(craftedFtyp('isom', ['iso2', 'avc1', 'mp41'])), 'mp4')
  assert.equal(sniffFamily(craftedFtyp('mp42', ['isom'])), 'mp4')
  assert.equal(sniffFamily(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0])), 'webm')
  assert.equal(sniffFamily(Buffer.from('<html>')), null)
  assert.equal(sniffFamily(craftedFtyp('qt  ', [])), null, 'unknown brand family is not mp4')
  assert.equal(sniffFamily(Buffer.alloc(0)), null)
  for (const [key, fam] of [['stillJpeg', 'jpeg'], ['stillPng', 'png'], ['stillWebp', 'webp'], ['bmp', 'bmp'], ['oneFrameGif', 'gif'], ['mp4Faststart', 'mp4'], ['webmWithCues', 'webm'], ['stillAvif', 'avif']]) {
    if (!fx[key]?.path) { t.diagnostic(`SKIP generated sniff ${key}: ${fx[key]?.skipped}`); continue } // crafted headers above always run
    const fh = await fs.open(fx[key].path); const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0); await fh.close()
    assert.equal(sniffFamily(buffer.subarray(0, bytesRead)), fam, key)
  }
})

test('FP-MISMATCH · content/extension disagreement → UNSUPPORTED / FAMILY_MISMATCH without invoking ffprobe', async () => {
  const runner = fakeFfprobe()
  const html = await write('page.jpg', Buffer.from('<html><body>not a jpeg</body></html>'))
  const r = await probe(html, 'jpg', { runner })
  assert.equal(r.unsupported, true)
  assert.equal(r.reason, 'FAMILY_MISMATCH')
  assert.equal(runner.calls.length, 0, 'header evidence suffices — no child process')
  const pngAsJpg = await write('png-named.jpg', craftedPng())
  const r2 = await probe(pngAsJpg, 'jpg', { runner })
  assert.equal(r2.reason, 'FAMILY_MISMATCH')
  assert.equal(r2.family, 'png', 'the sniffed family is reported for diagnostics')
  assert.equal(runner.calls.length, 0)
  const notAllowed = await probe(pngAsJpg, 'svg', { runner })
  assert.equal(notAllowed.unsupported, true)
  assert.equal(notAllowed.reason, 'UNSUPPORTED_TYPE')
  assert.equal(runner.calls.length, 0)
})

/* ── PNG / APNG ───────────────────────────────────────────────────────────── */
test('FP-PNG_NOT_ANIMATED · plain PNG (no acTL before IDAT) → animated false, dimensions from IHDR, no tool needed', async () => {
  const p = await write('plain.png', craftedPng({ width: 320, height: 180 }))
  const runner = fakeFfprobe()
  const r = await probe(p, 'png', { runner })
  assert.equal(r.unsupported, false)
  assert.equal(r.family, 'png')
  assert.equal(r.animated, false)
  assert.equal(r.animationEvidence, 'png-no-actl')
  assert.equal(r.posterOnly, false)
  assert.deepEqual([r.width, r.height, r.pixels], [320, 180, 57_600])
  assert.equal(r.durationSeconds, null)
  assert.equal(runner.calls.length, 0, 'PNG dimensions come from the header')
  assert.equal(probeApngAnimation(craftedPng()).animated, false)
})

test('FP-APNG_ANIMATED · acTL before IDAT with num_frames > 1 → animated true; num_frames 1 → false', async (t) => {
  const anim = craftedPng({ chunks: [actl(12)] })
  const rule = probeApngAnimation(anim)
  assert.deepEqual({ animated: rule.animated, evidence: rule.evidence, frames: rule.frames }, { animated: true, evidence: 'apng-actl-before-idat', frames: 12 })
  const single = probeApngAnimation(craftedPng({ chunks: [actl(1)] }))
  assert.equal(single.animated, false)
  const p = await write('crafted-anim.png', anim)
  const r = await probe(p, 'png')
  assert.equal(r.animated, true)
  assert.equal(r.frames, 12)
  assert.equal(r.posterOnly, false)
  if (realCase(t, 'apng')) {
    const real = await probeMedia({ absPath: fx.apng.path, ext: 'png', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, true, JSON.stringify(real))
    assert.equal(real.animationEvidence, 'apng-actl-before-idat')
  }
})

test('FP-BUDGETS · APNG walk stops at 32 chunks / 64 KiB (undecided → null); WebP rule reads only the first bytes', async () => {
  // 40 KiB of tEXt before IDAT: still decided within budget
  const within = probeApngAnimation(craftedPng({ chunks: [textChunk(20_000), textChunk(20_000), actl(3)] }))
  assert.equal(within.animated, true)
  // 100 KiB of tEXt before any decision: budget exhausted → null
  const over = probeApngAnimation(craftedPng({ chunks: [textChunk(50_000), textChunk(50_000), actl(3)] }))
  assert.equal(over.animated, null)
  assert.equal(over.evidence, 'apng-budget-exhausted')
  // 33 tiny chunks before IDAT: chunk budget exhausted → null
  const many = probeApngAnimation(craftedPng({ chunks: Array.from({ length: 33 }, () => pngChunk('tEXt', Buffer.from('k\0v'))) }))
  assert.equal(many.animated, null)
  assert.equal(probeApngAnimation.budget.maxChunks, 32)
  assert.equal(probeApngAnimation.budget.maxBytes, 65_536)
  // the WebP rule needs only the RIFF header + first chunk header (< 64 bytes)
  assert.equal(probeWebpAnimation.headerBytes <= 64, true)
  const p = await write('budget.png', craftedPng({ chunks: [textChunk(50_000), textChunk(50_000), actl(3)] }))
  const r = await probe(p, 'png')
  assert.equal(r.animated, null)
  assert.equal(r.posterOnly, true, 'undecided animation is poster-only')
  // probeMedia never buffers the whole file: a 3 MiB PNG tail is not read (bounded header only)
  const big = Buffer.concat([craftedPng({ width: 10, height: 10 }), Buffer.alloc(3 * 1_048_576, 0)])
  const bigPath = await write('big-tail.png', big)
  const reads = []
  const readHeader = async (absPath, bytes) => { reads.push(bytes); const fh = await fs.open(absPath); const { buffer, bytesRead } = await fh.read(Buffer.alloc(bytes), 0, bytes, 0); await fh.close(); return buffer.subarray(0, bytesRead) }
  const rb = await probe(bigPath, 'png', { readHeader })
  assert.equal(rb.animated, false)
  assert.ok(reads.every((n) => n <= 65_536), `header reads bounded, saw ${reads}`)
})

/* ── WebP ─────────────────────────────────────────────────────────────────── */
test('FP-STILL_WEBP_NOT_ANIMATED · no VP8X animation flag → false (VP8 and VP8X-without-flag)', async (t) => {
  assert.equal(probeWebpAnimation(craftedWebp({ vp8x: false }), { pageEvidence: null }).animated, false)
  const noFlag = probeWebpAnimation(craftedWebp({ vp8x: true, animation: false }), { pageEvidence: null })
  assert.equal(noFlag.animated, false)
  assert.equal(noFlag.evidence, 'webp-no-vp8x-animation-flag')
  const p = await write('crafted-still.webp', craftedWebp({ vp8x: true, animation: false, width: 320, height: 180 }))
  const r = await probe(p, 'webp')
  assert.equal(r.animated, false)
  assert.deepEqual([r.width, r.height], [320, 180], 'VP8X canvas size from the header')
  if (realCase(t, 'stillWebp')) {
    const real = await probeMedia({ absPath: fx.stillWebp.path, ext: 'webp', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, false, JSON.stringify(real))
  }
})

test('FP-ANIMATED_WEBP_ANIMATED · VP8X flag + frame evidence (≥ 2 ANMF chunks in the bounded header, or provider pages) → true', async (t) => {
  const withPages = probeWebpAnimation(craftedWebp({ animation: true }), { pageEvidence: 5 })
  assert.deepEqual({ a: withPages.animated, e: withPages.evidence }, { a: true, e: 'webp-vp8x-flag-and-pages' })
  // container evidence: ANIM + two ANMF frame chunks inside the 64 KiB header — no tool, no decode
  const p = await write('crafted-anim.webp', craftedWebp({ animation: true, width: 64, height: 64, frames: 2 }))
  const runner = fakeFfprobe()
  const r = await probe(p, 'webp', { runner })
  assert.equal(r.animated, true)
  assert.equal(r.animationEvidence, 'webp-vp8x-flag-and-anmf')
  assert.equal(r.frames, null, 'ANMF walk proves ≥ 2, it does not count the whole file')
  assert.equal(runner.calls.length, 0, 'no child process for WebP animation evidence')
  // a single ANMF within the header (second frame beyond the budget) is not proof → null
  const one = await write('crafted-oneframe.webp', craftedWebp({ animation: true, frames: 1, frameBytes: 70_000 }))
  assert.equal((await probe(one, 'webp', { runner })).animated, null)
  // sharp-style metadata pages also count as page evidence (injected provider, sharp is not installed here)
  const flagOnly = await write('crafted-flag.webp', craftedWebp({ animation: true, width: 64, height: 64 }))
  const sharpStub = { metadataFor: async () => ({ width: 64, height: 64, pages: 7 }) }
  const rs = await probe(flagOnly, 'webp', { runner: fakeFfprobe(), metadataProvider: sharpStub })
  assert.equal(rs.animated, true)
  assert.equal(rs.animationEvidence, 'webp-vp8x-flag-and-pages')
  if (realCase(t, 'animatedWebp')) {
    const real = await probeMedia({ absPath: fx.animatedWebp.path, ext: 'webp', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, true, JSON.stringify(real))
    assert.equal(real.animationEvidence, 'webp-vp8x-flag-and-anmf')
  }
})

test('FP-ANIMATION_UNKNOWN_IS_POSTER_ONLY · VP8X flag set but pages unprovable → animated null, posterOnly true, no motion assumption', async () => {
  const rule = probeWebpAnimation(craftedWebp({ animation: true }), { pageEvidence: null })
  assert.equal(rule.animated, null)
  assert.equal(rule.evidence, 'webp-vp8x-flag-pages-unproven')
  assert.equal(probeWebpAnimation(craftedWebp({ animation: true }), { pageEvidence: 1 }).animated, null)
  const p = await write('crafted-flagged.webp', craftedWebp({ animation: true }))
  // flag set, no ANMF frame within the header budget, no metadata provider → nothing proves frames
  const runner = fakeFfprobe({ packets: [{ pts: 0 }, { pts: 1 }] })
  const r = await probe(p, 'webp', { runner })
  assert.equal(r.animated, null)
  assert.equal(r.posterOnly, true)
  assert.equal(r.unsupported, false, 'unknown animation is not an error: poster still allowed')
  assert.ok(!runner.calls.some((c) => c.args.includes('-show_packets')), 'WebP never uses a packet probe (a whole animation can be one packet)')
})

/* ── GIF ──────────────────────────────────────────────────────────────────── */
test('FP-ONE_FRAME_GIF_NOT_ANIMATED · one packet then trailer → false; NETSCAPE loop alone never decides', async (t) => {
  const p = await write('crafted-one.gif', Buffer.concat([craftedGifHeader(64, 64), Buffer.from('!\xff\x0bNETSCAPE2.0\x03\x01\0\0\0', 'latin1'), Buffer.from(';', 'latin1')]))
  const runner = fakeFfprobe({ packets: [{ pts: 0 }] })
  const r = await probe(p, 'gif', { runner })
  assert.equal(r.animated, false)
  assert.equal(r.animationEvidence, 'gif-single-packet')
  assert.deepEqual([r.width, r.height], [64, 64])
  const call = runner.calls.find((c) => c.args.includes('-show_packets'))
  assert.ok(call, 'packet probe used')
  assert.ok(call.args.includes('-read_intervals') && call.args[call.args.indexOf('-read_intervals') + 1] === '%+#2')
  assert.ok(!call.args.includes('-count_frames'), 'never a full-file frame count')
  assert.ok(call.args.includes('-probesize') && call.args.includes(String(limits.probesizeBytes)))
  assert.equal(call.timeoutMs, limits.probeTimeoutMs)
  if (realCase(t, 'oneFrameGif')) {
    const real = await probeMedia({ absPath: fx.oneFrameGif.path, ext: 'gif', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, false, JSON.stringify(real))
  }
})

test('FP-MULTIFRAME_GIF_ANIMATED · two packets → true; timeout before decision → null', async (t) => {
  const p = await write('crafted-multi.gif', Buffer.concat([craftedGifHeader(64, 64), Buffer.from(';', 'latin1')]))
  const r = await probe(p, 'gif', { runner: fakeFfprobe({ packets: [{ pts: 0 }, { pts: 1 }] }) })
  assert.equal(r.animated, true)
  assert.equal(r.animationEvidence, 'gif-second-packet')
  assert.equal(r.posterOnly, false)
  const to = await probe(p, 'gif', { runner: fakeFfprobe({ timedOut: true }) })
  assert.equal(to.animated, null)
  assert.equal(to.animationEvidence, 'gif-probe-timeout')
  assert.equal(to.posterOnly, true)
  assert.equal(to.unsupported, false)
  const direct = await probeGifAnimation({ absPath: p, runner: fakeFfprobe({ packets: [{}, {}] }), limits })
  assert.equal(direct.animated, true)
  if (realCase(t, 'multiFrameGif')) {
    const real = await probeMedia({ absPath: fx.multiFrameGif.path, ext: 'gif', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, true, JSON.stringify(real))
    assert.equal(real.animationEvidence, 'gif-second-packet')
  }
})

/* ── AVIF ─────────────────────────────────────────────────────────────────── */
test('FP-STILL_AVIF_NOT_ANIMATED · no avis brand → false; duration alone is never evidence', async (t) => {
  const p = await write('crafted-still.avif', craftedFtyp('avif', ['mif1', 'miaf']))
  // a lying container probe reporting a duration must not flip a still AVIF to animated
  const runner = fakeFfprobe({ streams: [{ codec_name: 'av1', width: 64, height: 64, nb_frames: '1', duration: '2.5' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.5' } })
  const r = await probe(p, 'avif', { runner })
  assert.equal(r.animated, false)
  assert.equal(r.animationEvidence, 'avif-no-avis-brand')
  assert.equal(r.posterOnly, false)
  assert.equal(probeAvifAnimation(craftedFtyp('avif', ['mif1']), { sampleCount: 40 }).animated, false, 'brand gate first')
  if (realCase(t, 'stillAvif')) {
    const real = await probeMedia({ absPath: fx.stillAvif.path, ext: 'avif', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, false, JSON.stringify(real))
  }
})

test('FP-ANIMATED_AVIF_ANIMATED_WHEN_SUPPORTED · avis brand + sample count > 1 → true; unprovable → null', async (t) => {
  const p = await write('crafted-anim.avif', craftedFtyp('avis', ['avif', 'msf1', 'iso8']))
  const proven = await probe(p, 'avif', { runner: fakeFfprobe({ streams: [{ codec_name: 'av1', width: 64, height: 64, nb_frames: '5', duration: '1.0' }], format: { duration: '1.0' } }) })
  assert.equal(proven.animated, true)
  assert.equal(proven.animationEvidence, 'avif-avis-sample-count')
  const noCount = await probe(p, 'avif', { runner: fakeFfprobe({ streams: [{ codec_name: 'av1', width: 64, height: 64, duration: '1.0' }], format: { duration: '1.0' } }) })
  assert.equal(noCount.animated, null, 'duration > 0 without a sample count is not proof')
  assert.equal(noCount.animationEvidence, 'avif-avis-unproven')
  assert.equal(noCount.posterOnly, true)
  const one = await probe(p, 'avif', { runner: fakeFfprobe({ streams: [{ codec_name: 'av1', width: 64, height: 64, nb_frames: '1' }] }) })
  assert.equal(one.animated, null)
  assert.equal(probeAvifAnimation(craftedFtyp('avis', ['avif']), { sampleCount: null }).animated, null)
  if (!realCase(t, 'animatedAvif')) return
  const real = await probeMedia({ absPath: fx.animatedAvif.path, ext: 'avif', limits, capabilities: realCaps, runner: realRunner })
  t.diagnostic(`real animated AVIF → animated=${real.animated} evidence=${real.animationEvidence}`)
  assert.ok(real.animated === true || real.animated === null, 'proven or truthfully unknown — never false for an avis sequence')
})

/* ── video ────────────────────────────────────────────────────────────────── */
test('FP-VIDEO · mp4/webm are motion-capable by family with evidence family-video; dimensions/duration from the container probe', async (t) => {
  const mp4 = await write('crafted-clip.mp4', craftedFtyp('isom', ['iso2', 'avc1', 'mp41']))
  const r = await probe(mp4, 'mp4', { runner: fakeFfprobe({ streams: [{ codec_name: 'h264', width: 1920, height: 1080, duration: '12.5' }], format: { duration: '12.5' } }) })
  assert.equal(r.unsupported, false)
  assert.equal(r.family, 'mp4')
  assert.equal(r.animated, true)
  assert.equal(r.animationEvidence, 'family-video')
  assert.deepEqual([r.width, r.height, r.pixels, r.durationSeconds], [1920, 1080, 2_073_600, 12.5])
  const webm = await write('crafted-clip.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]))
  const w = await probe(webm, 'webm', { runner: fakeFfprobe({ streams: [{ codec_name: 'vp8', width: 160, height: 90 }], format: { duration: '4.0' } }) })
  assert.equal(w.animated, true)
  assert.equal(w.durationSeconds, 4)
  for (const key of ['mp4Faststart', 'webmWithCues']) {
    if (!realCase(t, key)) continue
    const real = await probeMedia({ absPath: fx[key].path, ext: key.startsWith('mp4') ? 'mp4' : 'webm', limits, capabilities: realCaps, runner: realRunner })
    assert.equal(real.animated, true, JSON.stringify(real))
    assert.deepEqual([real.width, real.height], [160, 90])
    assert.ok(real.durationSeconds > 3.5 && real.durationSeconds < 4.5)
  }
})

/* ── guards ───────────────────────────────────────────────────────────────── */
test('FP-DIMENSIONS · 45 MP → UNSUPPORTED/DIMENSIONS before any decode; 36 MP accepted; video frame guard separate', async (t) => {
  const over = await write('over.png', craftedPng({ width: 9000, height: 5000 }))
  const runner = fakeFfprobe()
  const started = process.hrtime.bigint()
  const r = await probe(over, 'png', { runner })
  t.diagnostic(`over-pixel rejection elapsedMs=${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2)}`)
  assert.equal(r.unsupported, true)
  assert.equal(r.reason, 'DIMENSIONS')
  assert.deepEqual([r.width, r.height, r.pixels], [9000, 5000, 45_000_000])
  assert.equal(runner.calls.length, 0, 'metadata path only — no decoder/generator/child invoked')
  const within = await write('within.png', craftedPng({ width: 12000, height: 3000 }))
  const ok = await probe(within, 'png', { runner })
  assert.equal(ok.unsupported, false)
  assert.equal(ok.pixels, 36_000_000)
  const edge = await write('edge.png', craftedPng({ width: 8000, height: 5000 }))
  assert.equal((await probe(edge, 'png', { runner })).unsupported, false, 'exactly the guard is allowed')
  const video = await write('huge.mp4', craftedFtyp('isom', ['avc1']))
  const v = await probe(video, 'mp4', { runner: fakeFfprobe({ streams: [{ codec_name: 'h264', width: 8192, height: 4320, duration: '1' }], format: {} }) })
  assert.equal(v.unsupported, false, '8K frame is exactly the video guard')
  const v2 = await probe(video, 'mp4', { runner: fakeFfprobe({ streams: [{ codec_name: 'h264', width: 8192, height: 4321, duration: '1' }], format: {} }) })
  assert.equal(v2.reason, 'DIMENSIONS')
})

test('FP-MALFORMED · probe failures are safe results: PROBE_FAILED with bounded detail, never a throw or a leaked stream', async (t) => {
  const bad = await write('crafted-bad.mp4', craftedFtyp('isom', ['avc1']))
  const r = await probe(bad, 'mp4', { runner: fakeFfprobe({ exitCode: 1, stderr: 'moov atom not found\n'.repeat(5000) }) })
  assert.equal(r.unsupported, true)
  assert.equal(r.reason, 'PROBE_FAILED')
  assert.equal(r.detail.exitCode, 1)
  assert.ok(Buffer.byteLength(r.detail.stderr, 'utf8') <= 512, 'stderr detail is bounded in UTF-8 bytes, not code units')
  const timeout = await probe(bad, 'mp4', { runner: fakeFfprobe({ timedOut: true }) })
  assert.equal(timeout.reason, 'PROBE_FAILED')
  assert.equal(timeout.detail.timedOut, true)
  const garbage = await probe(bad, 'mp4', { runner: { async run() { return { code: 0, stdout: '{not json', stderr: '', timedOut: false, killed: false, durationMs: 1, metrics: null } } } })
  assert.equal(garbage.reason, 'PROBE_FAILED')
  const noTool = await probe(bad, 'mp4', { capabilities: CAPABILITIES_NONE, runner: fakeFfprobe() })
  assert.equal(noTool.reason, 'PROBE_FAILED')
  assert.equal(noTool.detail.cause, 'FFPROBE_UNAVAILABLE')
  const missing = await probe(path.join(dir, 'does-not-exist.png'), 'png')
  assert.equal(missing.reason, 'SOURCE_UNREADABLE')
  const empty = await write('empty.png', Buffer.alloc(0))
  assert.equal((await probe(empty, 'png')).reason, 'FAMILY_MISMATCH')
  if (realCase(t, 'truncatedMp4')) {
    const real = await probeMedia({ absPath: fx.truncatedMp4.path, ext: 'mp4', limits, capabilities: realCaps, runner: realRunner })
    t.diagnostic(`real truncated mp4 → unsupported=${real.unsupported} reason=${real.reason ?? ''} detail=${JSON.stringify(real.detail ?? null).slice(0, 80)}`)
    assert.ok(real.unsupported === true || real.animated === true, `truncated mp4 is either refused or probed truthfully: ${JSON.stringify(real)}`)
  }
})

test('FP-STDERR-BYTE-CAP · ffprobe stderr detail is bounded to 512 UTF-8 bytes on a codepoint boundary (2-byte and 3-byte cases)', async () => {
  const bad = await write('crafted-bad-stderr.mp4', craftedFtyp('isom', ['avc1']))
  for (const [label, ch] of [['2-byte é', 'é'], ['3-byte €', '€']]) {
    const multi = ch.repeat(1000) // 1000 code units → 2000 / 3000 UTF-8 bytes
    const r = await probe(bad, 'mp4', { runner: fakeFfprobe({ exitCode: 1, stderr: multi }) })
    assert.equal(r.unsupported, true, label)
    assert.equal(r.reason, 'PROBE_FAILED', label)
    assert.equal(typeof r.detail.stderr, 'string', label)
    assert.ok(Buffer.byteLength(r.detail.stderr, 'utf8') <= 512, `${label}: ${Buffer.byteLength(r.detail.stderr, 'utf8')} UTF-8 bytes > 512`)
    assert.ok(r.detail.stderr.length > 0, label)
    assert.ok(!r.detail.stderr.includes('�'), `${label}: a codepoint was split at the boundary`)
    for (const c of r.detail.stderr) assert.equal(c, ch, `${label}: only whole original characters survive`)
  }
  // ASCII behaviour is equivalent to a plain 512-character cut; empty stderr stays ''
  const ascii = await probe(bad, 'mp4', { runner: fakeFfprobe({ exitCode: 1, stderr: 'x'.repeat(600) }) })
  assert.equal(ascii.detail.stderr, 'x'.repeat(512))
  const empty = await probe(bad, 'mp4', { runner: fakeFfprobe({ exitCode: 1, stderr: '' }) })
  assert.equal(empty.detail.stderr, '')
  // mixed input: the cut lands before the first character that would exceed the budget
  const mixed = 'a'.repeat(510) + '€' + 'b'.repeat(50)
  const m = await probe(bad, 'mp4', { runner: fakeFfprobe({ exitCode: 1, stderr: mixed }) })
  assert.equal(m.detail.stderr, 'a'.repeat(510), 'the 3-byte € would make 513 bytes, so it is dropped whole')
})

test('FP-NO_GLOBAL_RULE · probe.js contains no generic frames>1||duration>0 rule and no shell/full-file read', async () => {
  const src = await fs.readFile(new URL('../server/media/probe.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /frames\s*>\s*1\s*\|\|/, 'no frames > 1 || … rule')
  assert.doesNotMatch(src, /duration(Seconds)?\s*>\s*0\s*\|\|/, 'no duration > 0 || … rule')
  assert.doesNotMatch(src, /\|\|\s*duration(Seconds)?\s*>\s*0/, 'no … || duration > 0 rule')
  assert.doesNotMatch(src, /'-count_frames'/, 'never a full-file frame count (argument)')
  assert.doesNotMatch(src, /readFile\(/, 'no whole-file read: bounded header reads only')
  assert.doesNotMatch(src, /child_process|exec\(|shell:\s*true/, 'child processes only through the runner')
  assert.match(src, /'-read_intervals'/, 'bounded two-packet strategy present')
})

test('FP-RESULT_SHAPE · ProbeResult carries every field Tasks 5–7 rely on, with null for unknowns', async () => {
  const p = await write('shape.png', craftedPng({ width: 4, height: 4 }))
  const r = await probe(p, 'png')
  for (const key of ['probeVersion', 'family', 'width', 'height', 'pixels', 'durationSeconds', 'frames', 'animated', 'animationEvidence', 'posterOnly', 'unsupported', 'reason', 'engine', 'measuredAt']) {
    assert.ok(Object.hasOwn(r, key), `missing ${key}`)
  }
  assert.equal(r.reason, null)
  assert.equal(r.durationSeconds, null)
  assert.equal(r.frames, null)
  assert.equal(r.probeVersion, 1)
  assert.equal(typeof r.measuredAt, 'string')
})
