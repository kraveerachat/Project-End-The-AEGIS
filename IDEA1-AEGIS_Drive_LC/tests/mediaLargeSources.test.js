// tests/mediaLargeSources.test.js — AEGIS Drive (IDEA1) · large-media evidence gate (plan Task 16, spec §23–§24)
//
// ⚠️ รัน "ใน candidate image" เป็นหลัก (MEDIA_TOOLCHAIN_PROVENANCE=PACKAGED_CANDIDATE) — บนเครื่องอื่นเป็น SUPPLEMENTAL
//    import เฉพาะ dependency ของ production (node:*, sharp, โมดูล server) เพราะ runtime image ไม่มี devDependencies
// ⚠️ ความจริงมาก่อนความสวย: fixture ที่สร้างไม่ได้/พิสูจน์โครงสร้างไม่ผ่าน = "# NOT_PROVEN <class> <reason>" และข้ามแถวของ
//    class นั้น ไม่ใช่ผ่านบน zero padding; ขอบเขตไบต์ (< 64 MiB) ยืนยันเฉพาะ MP4 faststart / WebM+Cues; ที่เหลือ "บันทึก" เท่านั้น
// ⚠️ ไม่มีไบนารีใหญ่ใน Git: ทุกอย่างสร้างใน tmp ตอนรันและถูกลบ
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { detectCapabilities } from '../server/media/capabilities.js'
import { createProcessRunner } from '../server/media/processRunner.js'
import { probeMedia } from '../server/media/probe.js'
import { generatePoster } from '../server/media/poster.js'
import { generateMotion } from '../server/media/motion.js'
import { makeSparseMp4, makeSparseWebm, verifyFixture, idAt, EBML_IDS } from './helpers/sparseContainers.mjs'
import { makeByteClassFixture, makeNoisePng, craftedPng, BYTE_CLASSES, MiB } from './helpers/mediaFixtures.mjs'

const GiB = 1024 ** 3
const LINUX = process.platform === 'linux'
const exec = (bin, args, timeoutMs = 300_000) => new Promise((resolve) => {
  execFile(bin, args, { shell: false, timeout: timeoutMs, maxBuffer: 8 * MiB }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err }))
})

let caps, sharp = null, limits, runner, base, storageDir, cacheDir, gate = { ok: false, reason: null }
const provenance = {}
const notProven = new Map() // class → reason

before(async () => {
  base = await fs.mkdtemp(path.join(process.env.MEDIA_GATE_TMP || os.tmpdir(), 'aegis-media-large-'))
  storageDir = path.join(base, 'storage'); cacheDir = path.join(base, 'cache')
  await fs.mkdir(storageDir, { recursive: true }); await fs.mkdir(cacheDir, { recursive: true })
  limits = mediaLimitsFromEnv({ ...process.env, MEDIA_CACHE_DIR: cacheDir.replace(/\\/g, '/') })
  runner = createProcessRunner({ metrics: true })
  caps = await detectCapabilities({ runner, loadSharp: () => import('sharp').then((m) => m.default ?? m) })
  if (caps.sharp.ok) { try { sharp = (await import('sharp')).default; sharp.concurrency(1); sharp.cache(false) } catch { sharp = null } }
  const alpine = await fs.readFile('/etc/alpine-release', 'utf8').catch(() => null)
  provenance.MEDIA_TOOLCHAIN_PROVENANCE = process.env.CANDIDATE_IMAGE_ID ? 'PACKAGED_CANDIDATE' : 'HOST_SUPPLEMENTAL'
  provenance.CANDIDATE_IMAGE_ID = process.env.CANDIDATE_IMAGE_ID ?? 'n/a'
  provenance.FFMPEG_VERSION = caps.ffmpeg.version ?? 'absent'; provenance.FFPROBE_VERSION = caps.ffprobe.version ?? 'absent'
  provenance.SHARP_VERSION = sharp ? `${sharp.versions.sharp} (vips ${sharp.versions.vips})` : 'absent'
  provenance.ALPINE_VERSION = alpine ? alpine.trim() : 'n/a'; provenance.NODE = process.version; provenance.PLATFORM = `${process.platform} ${os.arch()}`
  gate = !LINUX ? { ok: false, reason: 'linux-gate: not linux (metrics need /proc)' } : !caps.enabled ? { ok: false, reason: `linux-gate: tools missing (${caps.reasons.join(',')})` } : { ok: true, reason: null }
})
after(async () => { await fs.rm(base, { recursive: true, force: true }).catch(() => {}) })

const skipIfNoGate = (t) => { if (!gate.ok) { t.skip(gate.reason); return true } return false }
const diag = (t, k, v) => t.diagnostic(`${k}=${v}`)
const notProve = (t, klass, reason) => { notProven.set(klass, reason); t.diagnostic(`# NOT_PROVEN ${klass} ${String(reason).slice(0, 300)}`) }

/** ทำงานทั้ง chain ด้วย runner ที่วัด /proc — คืนตัวเลขดิบ (ไม่ตัดสิน) */
async function runChain({ absPath, ext, motion = true }) {
  const runs = []
  const spy = { run: async (o) => { const r = await runner.run(o); runs.push(r); return r } }
  const out = { readBytes: 0, rchar: 0, vmHwmKb: 0, runs: 0, poster: null, motion: null, probe: null, error: null }
  const t0 = Date.now()
  try {
    out.probe = await probeMedia({ absPath, ext, limits, capabilities: caps, runner: spy, metadataProvider: sharp ? { metadataFor: (p) => sharp(p).metadata() } : null })
    out.probeMs = Date.now() - t0
    if (!out.probe.unsupported) {
      const tp = path.join(cacheDir, `poster-${path.basename(absPath)}.webp`)
      const t1 = Date.now()
      const p = await generatePoster({ absPath, probe: out.probe, tmpPath: tp, limits, capabilities: caps, runner: spy, sharp })
      out.poster = { ...p, ms: Date.now() - t1 }
      await fs.rm(tp, { force: true })
      if (motion && out.probe.animated === true) {
        const tm = path.join(cacheDir, `motion-${path.basename(absPath)}.mp4`)
        const t2 = Date.now()
        const m = await generateMotion({ absPath, probe: out.probe, tmpPath: tm, limits, capabilities: caps, runner: spy })
        out.motion = { ...m, ms: Date.now() - t2 }
        await fs.rm(tm, { force: true })
      }
    }
  } catch (err) { out.error = { class: err.class ?? 'INTERNAL', reason: err.reason ?? err.message, detail: err.detail ?? null } }
  for (const r of runs) { if (r.metrics) { out.readBytes += r.metrics.readBytes ?? 0; out.rchar += r.metrics.rchar ?? 0; out.vmHwmKb = Math.max(out.vmHwmKb, r.metrics.vmHwmKb ?? 0) } }
  out.runs = runs.length
  return out
}
const summary = (r) => `probe=${r.probe ? (r.probe.unsupported ? `UNSUPPORTED/${r.probe.reason}` : `${r.probe.family} ${r.probe.width}x${r.probe.height} animated=${r.probe.animated}`) : 'n/a'} poster=${r.poster ? `${r.poster.bytes}B ${r.poster.width}x${r.poster.height} ${r.poster.engine} ${r.poster.ms}ms` : (r.error ? `ERR ${r.error.class}/${r.error.reason}` : 'n/a')} motion=${r.motion ? `${r.motion.bytes}B ${r.motion.seconds}s ${r.motion.ms}ms` : 'n/a'} readBytes=${r.readBytes} rchar=${r.rchar} vmHwmKb=${r.vmHwmKb} childRuns=${r.runs}`

test('PROVENANCE header (copied into the PR body)', (t) => {
  for (const [k, v] of Object.entries(provenance)) diag(t, k, v)
  diag(t, 'LINUX_GATE', gate.ok ? 'ACTIVE' : `SKIPPED (${gate.reason})`)
  diag(t, 'MEDIA_LIMITS', `posterMaxBytes=${limits.posterMaxBytes} motionMaxBytes=${limits.motionMaxBytes} maxSourcePixels=${limits.maxSourcePixels} probesize=${limits.probesizeBytes}`)
})

/* ── sparse container fixtures ───────────────────────────────────────────── */
const sparse = {} // class → { path, bytes, verify } | null
async function buildSparse(t, klass, spanBytes, builder) {
  if (skipIfNoGate(t)) return null
  try {
    const srcDir = path.join(base, 'src'); await fs.mkdir(srcDir, { recursive: true })
    const out = await builder(srcDir)
    const v = await verifyFixture(out.path)
    sparse[klass] = { ...out, verify: v }
    diag(t, `${klass}_BYTES`, v.bytes); diag(t, `${klass}_ALLOCATED_BYTES`, v.allocatedBytes); diag(t, `${klass}_FFPROBE`, JSON.stringify(v.ffprobe))
    return sparse[klass]
  } catch (err) { notProve(t, klass, err.message); sparse[klass] = null; return null }
}
const shortSrc = async (dir, name, args, seconds = 4) => {
  const file = path.join(dir, name)
  const r = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', String(seconds), ...args, file], 120_000)
  if (!r.ok) throw new Error(`source ${name}: ${r.stderr.trim().split('\n').pop()}`)
  return file
}
const sparseClass = (klass, gib, spec) => test(`FIXTURE_${klass}_${gib}G structural integrity`, async (t) => {
  const built = await buildSparse(t, `${klass}_${gib}G`, gib * GiB, async (dir) => {
    const out = path.join(base, `${klass.toLowerCase()}-${gib}g.${spec.ext}`)
    const src = await shortSrc(dir, `src-${klass.toLowerCase()}.${spec.ext}`, spec.srcArgs, spec.seconds ?? 4)
    const r = spec.mp4 ? await makeSparseMp4({ src, spanBytes: gib * GiB, layout: spec.layout, out }) : await makeSparseWebm({ src, spanBytes: gib * GiB, cues: spec.cues, out, voidAfter: spec.voidAfter })
    return { path: out, ...r }
  })
  if (!built) return
  const v = built.verify
  try {
    assert.ok(v.bytes >= gib * GiB, 'stat.size ≥ span')
    assert.ok(v.allocatedBytes < 64 * MiB, `FIXTURE_SPARSE_REALITY: allocated ${v.allocatedBytes} B must be < 64 MiB`)
    if (spec.mp4) {
      assert.equal(v.boxes[0].type, 'ftyp')
      if (spec.layout === 'faststart') { assert.ok(v.moovOffset < v.mdatOffset); assert.ok(v.moovOffset < MiB, 'moov within the first MiB') }
      else { assert.equal(v.moovOffset, v.bytes - v.moovSize, 'moov is the final box of the final file'); assert.ok(v.mdatOffset < v.moovOffset) }
      assert.ok(v.ffprobe.ok, `ffprobe: ${v.ffprobe.error}`); assert.ok(Math.abs(v.ffprobe.durationSeconds - (spec.seconds ?? 4)) <= 0.1, `duration ${v.ffprobe.durationSeconds}`)
      const dec = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', built.path, '-frames:v', '1', '-f', 'null', '-'], 120_000)
      assert.ok(dec.ok, `first-frame decode (co64 re-basing): ${dec.stderr.trim().split('\n').pop()}`)
    } else {
      if (spec.cues) {
        assert.equal(v.hasCues, true); assert.ok(v.cuesOffset > v.firstClusterOffset, 'Cues after the clusters')
        assert.ok(v.cuePositions.length > 0)
        for (const p of v.cuePositions) assert.equal(await idAt(built.path, p), EBML_IDS.CLUSTER, `CuePosition ${p} resolves to a Cluster`)
        for (const s of v.seekPositions ?? []) assert.equal(await idAt(built.path, s.absolute), s.id, `SeekPosition for 0x${s.id.toString(16)} resolves`)
        assert.ok(v.ffprobe.ok, `ffprobe: ${v.ffprobe.error}`)
      } else {
        assert.equal(v.hasCues, false); assert.ok(!(v.seekPositions ?? []).some((s) => s.id === EBML_IDS.CUES), 'no SeekHead entry for Cues')
        diag(t, `${klass}_${gib}G_FFPROBE_OUTCOME`, v.ffprobe.ok ? 'ok' : `failed-within-timeout: ${v.ffprobe.error}`)
      }
      const dec = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', built.path, '-frames:v', '1', '-f', 'null', '-'], 120_000)
      assert.ok(dec.ok, `first-frame decode: ${dec.stderr.trim().split('\n').pop()}`)
    }
  } catch (err) { notProve(t, `${klass}_${gib}G`, err.message); sparse[`${klass}_${gib}G`] = null; throw err }
})
// WebM มีสองรูปทรง: *_VOID_FIRST = ช่องว่างก่อน Cluster แรก (plan; ไม่มีข้อมูลสื่อใน 10 GiB แรก — ไฟล์จริงไม่เป็นแบบนี้)
//                    *_MID = ช่องว่างหลัง Cluster แรก (ใกล้เคียงไฟล์ใหญ่จริงกว่า)
// ⚠️ วัดแล้ว (packaged ffmpeg 8.0.1): matroska demuxer "อ่านผ่าน" element Void ทั้งก้อน (rchar ≈ ขนาดไฟล์) แทนที่จะ seek ข้าม
//    — MP4 (กล่อง free) ถูก seek ข้ามจริง (rchar หลักหมื่นไบต์) จึงยืนยันขอบเขต < 64 MiB เฉพาะ MP4_FASTSTART;
//    สำหรับ WebM ขอบเขตนั้น NOT_PROVEN ด้วย sparse fixture (ผลของ Void สังเคราะห์ ไม่ใช่ตัวแทนของไฟล์จริงที่ไม่มี Void)
//    → บันทึกค่า rchar และเวลาที่ใช้ (ต้องจบภายใน timeout, VmHWM < 1 GiB) แต่ไม่ assert ขอบเขตไบต์ให้ WebM
const SPECS = {
  MP4_FASTSTART: { mp4: true, layout: 'faststart', ext: 'mp4', srcArgs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  MP4_MOOV_AT_END: { mp4: true, layout: 'moov-at-end', ext: 'mp4', srcArgs: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  WEBM_CUES_MID: { mp4: false, cues: true, ext: 'webm', seconds: 12, voidAfter: 'first-cluster', srcArgs: ['-c:v', 'libvpx', '-b:v', '200k'] },
  WEBM_NO_CUES_MID: { mp4: false, cues: false, ext: 'webm', seconds: 12, voidAfter: 'first-cluster', srcArgs: ['-c:v', 'libvpx', '-b:v', '200k', '-live', '1'] },
  WEBM_CUES_VOID_FIRST: { mp4: false, cues: true, ext: 'webm', voidAfter: 'before-first-cluster', srcArgs: ['-c:v', 'libvpx', '-b:v', '200k'] },
  WEBM_NO_CUES_VOID_FIRST: { mp4: false, cues: false, ext: 'webm', voidAfter: 'before-first-cluster', srcArgs: ['-c:v', 'libvpx', '-b:v', '200k', '-live', '1'] },
}
for (const [klass, spec] of Object.entries(SPECS)) sparseClass(klass, 10, spec)
if (process.env.MEDIA_GATE_20G !== '0') for (const [klass, spec] of Object.entries(SPECS)) sparseClass(klass, 20, spec)

/* ── byte-class fixtures ─────────────────────────────────────────────────── */
const classes = {} // key → fixture | null
async function buildClass(t, key, fn) {
  if (skipIfNoGate(t)) return null
  try {
    const t0 = Date.now()
    const f = await fn()
    classes[key] = f
    diag(t, `${key}_SOURCE_BYTES`, f.bytes); diag(t, `${key}_GEOMETRY`, `${f.width}x${f.height} pixels=${f.pixels} format=${f.format}${f.frames ? ` frames=${f.frames}` : ''}${f.seconds ? ` seconds=${f.seconds}` : ''} iterations=${f.iterations ?? 1} genMs=${Date.now() - t0}`)
    return f
  } catch (err) { notProve(t, key, err.message); classes[key] = null; return null }
}
const inBand = (f, band) => f.bytes >= band.lo && f.bytes <= band.hi
const fixturesDir = () => path.join(base, 'fx')

test('CLASS_200MB_STILL / CLASS_300MB_STILL / CLASS_OVER_PIXELS byte classes proven by stat', async (t) => {
  if (skipIfNoGate(t)) return
  await fs.mkdir(fixturesDir(), { recursive: true })
  const a = await buildClass(t, 'IMAGE_200MB', () => makeByteClassFixture({ dir: fixturesDir(), klass: 'still200' }))
  if (a) { assert.ok(inBand(a, BYTE_CLASSES.still200), `200MB band: ${a.bytes}`); assert.ok(a.pixels <= limits.maxSourcePixels) }
  const b = await buildClass(t, 'IMAGE_300MB', () => makeByteClassFixture({ dir: fixturesDir(), klass: 'still300' }))
  if (b) { assert.ok(inBand(b, BYTE_CLASSES.still300), `300MB band: ${b.bytes}`); assert.equal(b.pixels, 40_000_000); assert.ok(b.pixels <= limits.maxSourcePixels, 'boundary: exactly the guard is allowed') }
  const over = path.join(fixturesDir(), 'over-45mp.png')
  await fs.writeFile(over, craftedPng({ width: 9000, height: 5000 }))
  classes.OVER_PIXELS = { path: over, bytes: (await fs.stat(over)).size, width: 9000, height: 5000, pixels: 45_000_000, format: 'png-header-only' }
})

test('CLASS_GIF_518KB / CLASS_GIF_49MB / CLASS_VIDEO_196MB byte classes proven by stat', async (t) => {
  if (skipIfNoGate(t)) return
  await fs.mkdir(fixturesDir(), { recursive: true })
  const g1 = await buildClass(t, 'GIF_518KB', () => makeByteClassFixture({ dir: fixturesDir(), klass: 'gif518k' }))
  if (g1) assert.ok(inBand(g1, BYTE_CLASSES.gif518k), `${g1.bytes}`)
  const g2 = await buildClass(t, 'GIF_49MB', () => makeByteClassFixture({ dir: fixturesDir(), klass: 'gif49m' }))
  if (g2) assert.ok(inBand(g2, BYTE_CLASSES.gif49m), `${g2.bytes}`)
  const v = await buildClass(t, 'VIDEO_196MB', () => makeByteClassFixture({ dir: fixturesDir(), klass: 'video196' }))
  if (v) assert.ok(inBand(v, BYTE_CLASSES.video196), `${v.bytes}`)
  diag(t, 'REAL_49_7MB_GIF_PREPROD', 'NOT_AVAILABLE (deterministic 45–55 MiB fixture used; the real file stays mandatory in Production browser acceptance)')
})

test('CLASS_ANIM_200MB / CLASS_ANIM_300MB (GIF + APNG, high/low first window) byte classes proven by stat', async (t) => {
  if (skipIfNoGate(t)) return
  await fs.mkdir(fixturesDir(), { recursive: true })
  for (const klass of ['anim200', 'anim300']) {
    for (const codec of ['gif', 'apng']) {
      if (klass === 'anim300' && codec === 'apng' && process.env.MEDIA_GATE_APNG_300 === '0') { notProve(t, `APNG_300MB`, 'skipped by MEDIA_GATE_APNG_300=0'); continue }
      for (const variant of ['hi', 'lo']) {
        const key = `${codec.toUpperCase()}_${klass === 'anim200' ? '200MB' : '300MB'}_${variant.toUpperCase()}`
        const f = await buildClass(t, key, () => makeByteClassFixture({ dir: fixturesDir(), klass, codec, variant }))
        if (f) assert.ok(inBand(f, BYTE_CLASSES[klass]), `${key}: ${f.bytes}`)
      }
    }
  }
})

/* ── large-source performance rows (only proven fixtures) ─────────────────── */
const row = (t, key) => { const f = classes[key]; if (f === undefined) { t.skip(`${key}: fixture test did not run`); return null } if (!f) { t.skip(`NOT_PROVEN ${key}: ${notProven.get(key)}`); return null } return f }

test('LS-SMALL 64 KiB-class PNG → poster ≤ 512 KiB', async (t) => {
  if (skipIfNoGate(t)) return
  const small = await makeNoisePng({ out: path.join(base, 'small.png'), width: 160, height: 100, channels: 3 })
  const r = await runChain({ absPath: small.path, ext: 'png' })
  diag(t, 'LS_SMALL', summary(r))
  assert.equal(r.error, null, JSON.stringify(r.error)); assert.ok(r.poster.bytes <= limits.posterMaxBytes)
})

for (const key of ['IMAGE_200MB', 'IMAGE_300MB']) {
  test(`LS-${key} still → poster within posterTimeoutMs, ≤ 512 KiB; peak RSS recorded`, async (t) => {
    if (skipIfNoGate(t)) return
    const f = row(t, key); if (!f) return
    const before = process.memoryUsage().rss
    const r = await runChain({ absPath: f.path, ext: 'png' })
    diag(t, `LS_${key}`, `${summary(r)} nodeRssDeltaMiB=${((process.memoryUsage().rss - before) / MiB).toFixed(1)}`)
    assert.equal(r.error, null, JSON.stringify(r.error))
    assert.ok(r.poster.bytes <= limits.posterMaxBytes, `poster ${r.poster.bytes} B`)
    assert.ok(r.poster.ms <= limits.posterTimeoutMs, `poster took ${r.poster.ms} ms`)
    assert.ok(r.poster.width <= limits.posterBox.width && r.poster.height <= limits.posterBox.height)
  })
}
test('LS-OVER_PIXELS 45 MP header → UNSUPPORTED DIMENSIONS quickly, no decode', async (t) => {
  if (skipIfNoGate(t)) return
  const f = row(t, 'OVER_PIXELS'); if (!f) return
  const t0 = Date.now()
  const r = await runChain({ absPath: f.path, ext: 'png' })
  diag(t, 'LS_OVER_PIXELS', `${summary(r)} totalMs=${Date.now() - t0}`)
  assert.equal(r.probe.unsupported, true); assert.equal(r.probe.reason, 'DIMENSIONS'); assert.ok(Date.now() - t0 < 5000)
})
for (const key of ['GIF_518KB', 'GIF_49MB']) {
  test(`LS-${key} → poster + motion succeed within caps; source read bytes recorded (not bounded)`, async (t) => {
    if (skipIfNoGate(t)) return
    const f = row(t, key); if (!f) return
    const r = await runChain({ absPath: f.path, ext: 'gif' })
    diag(t, `LS_${key}`, summary(r)); diag(t, `${key}_SOURCE_READ_BYTES`, `rchar=${r.rchar} read_bytes=${r.readBytes} of ${f.bytes}`)
    assert.equal(r.error, null, JSON.stringify(r.error))
    assert.equal(r.probe.animated, true)
    assert.ok(r.poster.bytes <= limits.posterMaxBytes); assert.ok(r.motion && r.motion.bytes <= limits.motionMaxBytes); assert.ok(r.motion.seconds <= 6.1)
  })
}
for (const codec of ['GIF', 'APNG']) {
  for (const size of ['200MB', '300MB']) {
    test(`LS-ANIM-${codec}-${size} hi/lo first window → motion ≤ 6.1 s, ≤ 4 MiB, within timeout; readBytes(hi) ≥ readBytes(lo) recorded; no fixed byte bound`, async (t) => {
      if (skipIfNoGate(t)) return
      const hi = row(t, `${codec}_${size}_HI`); if (!hi) return
      const lo = row(t, `${codec}_${size}_LO`); if (!lo) return
      const ext = codec === 'GIF' ? 'gif' : 'png'
      const rh = await runChain({ absPath: hi.path, ext }); const rl = await runChain({ absPath: lo.path, ext })
      diag(t, `LS_ANIM_${codec}_${size}_HI`, summary(rh)); diag(t, `LS_ANIM_${codec}_${size}_LO`, summary(rl))
      diag(t, `${codec}_${size}_SOURCE_READ_BYTES`, `rchar hi=${rh.rchar} lo=${rl.rchar} (read_bytes hi=${rh.readBytes} lo=${rl.readBytes}) of ${hi.bytes}/${lo.bytes} (recorded, not a bound)`)
      for (const [label, r] of [['hi', rh], ['lo', rl]]) {
        assert.equal(r.error, null, `${label}: ${JSON.stringify(r.error)}`)
        assert.equal(r.probe.animated, true, `${label}: animated`)
        assert.ok(r.poster.bytes <= limits.posterMaxBytes, `${label} poster ${r.poster.bytes}`)
        assert.ok(r.motion && r.motion.bytes <= limits.motionMaxBytes, `${label} motion ${r.motion?.bytes}`)
        assert.ok(r.motion.seconds <= 6.1); assert.ok(r.motion.ms <= limits.motionTimeoutMs, `${label} motion ${r.motion.ms} ms`)
      }
      assert.ok(rh.rchar >= rl.rchar, `rchar(high) ${rh.rchar} ≥ rchar(low) ${rl.rchar}`)
    })
  }
}
test('LS-VIDEO-196MB → poster + motion; grid-relevant transfer = derivative bytes only', async (t) => {
  if (skipIfNoGate(t)) return
  const f = row(t, 'VIDEO_196MB'); if (!f) return
  const r = await runChain({ absPath: f.path, ext: 'mp4' })
  diag(t, 'LS_VIDEO_196MB', summary(r)); diag(t, 'VIDEO_196MB_SOURCE_READ_BYTES', `rchar=${r.rchar} read_bytes=${r.readBytes} of ${f.bytes}`)
  assert.equal(r.error, null, JSON.stringify(r.error))
  assert.ok(r.poster.bytes <= limits.posterMaxBytes); assert.ok(r.motion.bytes <= limits.motionMaxBytes)
  diag(t, 'VIDEO_196MB_BROWSER_TRANSFER_BYTES', `${r.poster.bytes + r.motion.bytes} (poster+motion) vs source ${f.bytes}`)
})

const BOUNDED = new Set(['MP4_FASTSTART'])
const READ_THROUGH_RECORDED = new Set(['WEBM_CUES_MID', 'WEBM_NO_CUES_MID'])
for (const gib of [10, 20]) {
  for (const klass of Object.keys(SPECS)) {
    test(`LS-SPARSE-${gib}G ${klass} → poster + motion or truthful failure within timeout; readBytes recorded${BOUNDED.has(klass) ? ' and < 64 MiB' : ''}; VmHWM < 1 GiB; no leaks`, async (t) => {
      if (skipIfNoGate(t)) return
      const key = `${klass}_${gib}G`
      const f = sparse[key]
      if (f === undefined) { t.skip(`${key}: fixture test did not run`); return }
      if (!f) { t.skip(`NOT_PROVEN ${key}: ${notProven.get(key)}`); return }
      const ext = SPECS[klass].ext
      const r = await runChain({ absPath: f.path, ext })
      // SOURCE_READ_BYTES = rchar (ไบต์ที่ child อ่านผ่าน read() ทั้งหมด รวม page cache); read_bytes = ไบต์ที่ไปถึงชั้น block จริง (0 เมื่ออยู่ใน cache)
      diag(t, `LS_SPARSE_${key}`, summary(r)); diag(t, `${key}_SOURCE_READ_BYTES`, `rchar=${r.rchar} read_bytes=${r.readBytes} of ${f.bytes}`)
      assert.ok(r.probeMs <= limits.probeTimeoutMs + 1000, `probe ${r.probeMs} ms within timeout`)
      const truthfulFailure = r.error ? ['TIMEOUT', 'DECODE_FAILED', 'ENCODE_FAILED', 'PROBE_FAILED'].includes(r.error.reason) : (r.probe?.unsupported ? ['PROBE_FAILED', 'SOURCE_UNREADABLE'].includes(r.probe.reason) : false)
      if (r.error || r.probe?.unsupported) assert.ok(truthfulFailure, `truthful failure class: ${JSON.stringify(r.error ?? r.probe)}`)
      else { assert.ok(r.poster.bytes <= limits.posterMaxBytes); if (r.motion) assert.ok(r.motion.bytes <= limits.motionMaxBytes) }
      if (BOUNDED.has(klass)) assert.ok(r.rchar < 64 * MiB, `${klass}: source read (rchar) ${r.rchar} B must stay < 64 MiB`)
      if (READ_THROUGH_RECORDED.has(klass)) diag(t, `${key}_READ_BOUND`, r.rchar < 64 * MiB ? 'MET (< 64 MiB)' : `NOT_MET_ON_SPARSE_FIXTURE (rchar ${r.rchar} ≈ file size: the demuxer reads through the synthetic Void; not generalised to real files)`)
      assert.ok(r.vmHwmKb < 1024 * 1024, `child VmHWM ${r.vmHwmKb} KiB < 1 GiB`)
      const ps = await exec('ps', ['-o', 'args'], 10_000)
      assert.ok(!ps.stdout.includes(path.basename(f.path)), 'no child process left holding the fixture')
      const tmpLeft = (await fs.readdir(cacheDir)).filter((n) => n.startsWith('poster-') || n.startsWith('motion-'))
      assert.deepEqual(tmpLeft, [], 'no tmp leak')
    })
  }
}
test('NOT_PROVEN summary', (t) => {
  if (notProven.size === 0) t.diagnostic('NOT_PROVEN_CLASSES=none')
  else for (const [k, v] of notProven) t.diagnostic(`NOT_PROVEN_CLASS ${k}: ${String(v).slice(0, 300)}`)
})
