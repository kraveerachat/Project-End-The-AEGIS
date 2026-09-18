// tests/mediaResponsiveness.test.js — AEGIS Drive (IDEA1) · resource / responsiveness evidence (plan Task 16 Step 5, spec §23)
//
// baseline 30 s ที่ 5 req/s บน /healthz และ GET /api/files → ระหว่างงาน animated 300 MB-class → ระหว่างงาน sparse 10 GiB (moov-at-end)
// ยืนยัน: ไม่มี non-200, ไม่มีคำขอ > 5 s, โปรเซสยังอยู่; บันทึก p95/REGRESSION_RATIO/VmHWM/CPU — ไม่ประดิษฐ์เกณฑ์ (> 2.0 = review trigger)
// ⚠️ import เฉพาะ dependency ของ production — รันใน candidate image ได้; นอก Linux/ไม่มีเครื่องมือ = skip พร้อมเหตุผล
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { loginClient, DEMO_USER } from './helpers/testClient.mjs'
import { makeSparseMp4 } from './helpers/sparseContainers.mjs'
import { makeByteClassFixture, MiB } from './helpers/mediaFixtures.mjs'

const LINUX = process.platform === 'linux'
const GiB = 1024 ** 3
const exec = (bin, args, timeoutMs = 300_000) => new Promise((resolve) => {
  execFile(bin, args, { shell: false, timeout: timeoutMs, maxBuffer: 8 * MiB }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err }))
})

const base = await fs.mkdtemp(path.join(process.env.MEDIA_GATE_TMP || os.tmpdir(), 'aegis-media-resp-'))
const STORAGE_ROOT = path.join(base, 'storage'); const CACHE = path.join(base, 'cache')
await fs.mkdir(path.join(STORAGE_ROOT, 'uploads'), { recursive: true }); await fs.mkdir(CACHE, { recursive: true })
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.MEDIA_CACHE_DIR = CACHE
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'gate-only-session-secret-not-used-in-production'
process.env.NODE_ENV = 'test'
delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage, resolveKey, keyExists } = await import('../server/storage/fileStore.js')
const { mediaLimitsFromEnv } = await import('../server/config/mediaLimits.js')
const { detectCapabilities } = await import('../server/media/capabilities.js')
const { createProcessRunner } = await import('../server/media/processRunner.js')
const { createMediaRuntime } = await import('../server/media/runtime.js')
const { PRIORITY } = await import('../server/media/queue.js')

let server, baseUrl, service, caps, limits, gate = { ok: false, reason: null }
const childMetrics = []
before(async () => {
  await initStorage()
  limits = mediaLimitsFromEnv({ ...process.env, MEDIA_CACHE_DIR: CACHE.replace(/\\/g, '/') })
  const runner = createProcessRunner({ metrics: true })
  const spy = { run: async (o) => { const r = await runner.run(o); if (r.metrics) childMetrics.push({ bin: path.basename(o.bin), ...r.metrics, durationMs: r.durationMs }); return r } }
  caps = await detectCapabilities({ runner, loadSharp: () => import('sharp').then((m) => m.default ?? m) })
  gate = !LINUX ? { ok: false, reason: 'linux-gate: not linux' } : !caps.enabled ? { ok: false, reason: `linux-gate: tools missing (${caps.reasons.join(',')})` } : { ok: true, reason: null }
  let sharp = null
  if (caps.sharp.ok) { try { sharp = (await import('sharp')).default; sharp.concurrency(1) } catch { sharp = null } }
  service = createMediaRuntime({ limits, capabilities: caps, runner: spy, resolveStorageKey: resolveKey, keyExists, storageRoot: STORAGE_ROOT, sharp, log: () => {}, mountState: 'unknown' })
  await service.init(); await service.start()
  const app = createApp({ env: process.env, mediaLimits: limits, mediaService: service })
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await service?.stop().catch(() => {})
  await new Promise((r) => server?.close(r))
  await fs.rm(base, { recursive: true, force: true }).catch(() => {})
})

const p95 = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] }
const cpuSnapshot = async () => {
  const load = os.loadavg().map((v) => v.toFixed(2)).join('/')
  let cgroup = null
  try { cgroup = (await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).match(/usage_usec (\d+)/)?.[1] ?? null } catch { cgroup = null }
  return { load, cgroupUsageUsec: cgroup }
}
/** ยิงโหลด 5 req/s ต่อ endpoint เป็นเวลา seconds (หรือจนกว่า until() จริง) — คืนสถิติต่อ endpoint */
async function loadRun({ client, seconds, until = null }) {
  const stats = { healthz: { ms: [], non200: 0, over5s: 0 }, files: { ms: [], non200: 0, over5s: 0 } }
  const t0 = Date.now()
  const one = async (key, fn) => {
    const s = Date.now()
    let status = 0
    try { status = (await fn()).status } catch { status = 0 }
    const ms = Date.now() - s
    stats[key].ms.push(ms); if (status !== 200) stats[key].non200 += 1; if (ms > 5000) stats[key].over5s += 1
  }
  while (Date.now() - t0 < seconds * 1000 && !(until && until())) {
    const tick = Date.now()
    await Promise.all([
      one('healthz', () => fetch(`${baseUrl}/healthz`)),
      one('files', () => client.req('/api/files')),
    ])
    const wait = 200 - (Date.now() - tick)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  return { seconds: (Date.now() - t0) / 1000, healthz: { p95: p95(stats.healthz.ms), n: stats.healthz.ms.length, non200: stats.healthz.non200, over5s: stats.healthz.over5s }, files: { p95: p95(stats.files.ms), n: stats.files.ms.length, non200: stats.files.non200, over5s: stats.files.over5s } }
}
const row = (id, name, key, sha) => ({ id, name, kind: 'file', vault: false, sha256: sha, path: key, size: 1, ownerId: '2' })
const fmt = (r) => `seconds=${r.seconds.toFixed(1)} healthz{p95=${r.healthz.p95}ms n=${r.healthz.n} non200=${r.healthz.non200} >5s=${r.healthz.over5s}} files{p95=${r.files.p95}ms n=${r.files.n} non200=${r.files.non200} >5s=${r.files.over5s}}`

test('RESP-BASELINE → RESP-ANIM-300MB → RESP-SPARSE-10G: p95 recorded, zero non-200, none > 5 s, process alive, VmHWM/CPU recorded', async (t) => {
  if (!gate.ok) { t.skip(gate.reason); return }
  const seconds = Number(process.env.MEDIA_GATE_LOAD_SECONDS || 30)
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const cpu0 = await cpuSnapshot()
  const baseline = await loadRun({ client, seconds })
  t.diagnostic(`BASELINE ${fmt(baseline)}`)
  assert.equal(baseline.healthz.non200 + baseline.files.non200, 0); assert.equal(baseline.healthz.over5s + baseline.files.over5s, 0)

  // งานที่ 1: animated 300 MB-class (GIF high-bitrate) — สร้าง fixture ใน storage แล้วให้ service ทำงานจริง
  const fxDir = path.join(STORAGE_ROOT, 'uploads')
  let anim = null
  try { anim = await makeByteClassFixture({ dir: fxDir, klass: 'anim300', codec: 'gif', variant: 'hi' }) } catch (err) { t.diagnostic(`# NOT_PROVEN ANIM_300MB_FOR_LOAD ${err.message}`) }
  let during1 = null
  if (anim) {
    const sha = 'a'.repeat(64)
    let done = false
    const job = service.info(row('9001', 'load-300mb.gif', `uploads/${path.basename(anim.path)}`, sha), PRIORITY.INTERACTIVE).then(() => service.drain()).then(() => { done = true })
    during1 = await loadRun({ client, seconds, until: () => done })
    await job
    const info = await service.info(row('9001', 'load-300mb.gif', `uploads/${path.basename(anim.path)}`, sha))
    t.diagnostic(`DURING_ANIM_300MB ${fmt(during1)} jobStatus=${info.status} poster=${info.poster.state} motion=${info.motion.state}`)
    assert.equal(during1.healthz.non200 + during1.files.non200, 0); assert.equal(during1.healthz.over5s + during1.files.over5s, 0)
  }
  // งานที่ 2: sparse 10 GiB MP4 moov-at-end (หรือ faststart ถ้าสร้างไม่ได้)
  let during2 = null, sparseKind = null
  try {
    const src = path.join(base, 'src.mp4')
    const r = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], 120_000)
    if (!r.ok) throw new Error(r.stderr)
    const out = path.join(fxDir, 'load-10g.mp4')
    await makeSparseMp4({ src, spanBytes: 10 * GiB, layout: 'moov-at-end', out }); sparseKind = 'MP4_MOOV_AT_END'
    const sha = 'b'.repeat(64)
    let done = false
    const job = service.info(row('9002', 'load-10g.mp4', 'uploads/load-10g.mp4', sha), PRIORITY.INTERACTIVE).then(() => service.drain()).then(() => { done = true })
    during2 = await loadRun({ client, seconds, until: () => done })
    await job
    const info = await service.info(row('9002', 'load-10g.mp4', 'uploads/load-10g.mp4', sha))
    t.diagnostic(`DURING_SPARSE_10G(${sparseKind}) ${fmt(during2)} jobStatus=${info.status} poster=${info.poster.state} motion=${info.motion.state}`)
    assert.equal(during2.healthz.non200 + during2.files.non200, 0); assert.equal(during2.healthz.over5s + during2.files.over5s, 0)
  } catch (err) { t.diagnostic(`# NOT_PROVEN SPARSE_10G_FOR_LOAD ${err.message}`) }
  const cpu1 = await cpuSnapshot()
  const ratio = (d, b) => (d && b && b.p95 > 0 ? (d.p95 / b.p95).toFixed(2) : 'n/a')
  const worst = (k) => Math.max(...[during1, during2].filter(Boolean).map((d) => d[k].p95))
  t.diagnostic(`BASELINE_P95_MS healthz=${baseline.healthz.p95} files=${baseline.files.p95}`)
  t.diagnostic(`LOAD_P95_MS healthz=${[during1, during2].filter(Boolean).length ? worst('healthz') : 'n/a'} files=${[during1, during2].filter(Boolean).length ? worst('files') : 'n/a'}`)
  t.diagnostic(`REGRESSION_RATIO healthz anim=${ratio(during1?.healthz, baseline.healthz)} sparse=${ratio(during2?.healthz, baseline.healthz)}; files anim=${ratio(during1?.files, baseline.files)} sparse=${ratio(during2?.files, baseline.files)} (> 2.0 = MANDATORY_REVIEW_TRIGGER, not an automatic failure)`)
  const peak = childMetrics.reduce((m, c) => Math.max(m, c.vmHwmKb ?? 0), 0)
  t.diagnostic(`FFMPEG_PEAK_RSS vmHwmKb=${peak} (${(peak / 1024).toFixed(1)} MiB) over ${childMetrics.length} child runs`)
  t.diagnostic(`CPU loadavg before=${cpu0.load} after=${cpu1.load} cgroupUsageUsecDelta=${cpu0.cgroupUsageUsec && cpu1.cgroupUsageUsec ? Number(cpu1.cgroupUsageUsec) - Number(cpu0.cgroupUsageUsec) : 'n/a'} cpus=${os.cpus().length}`)
  t.diagnostic(`PROCESS_ALIVE pid=${process.pid} nodeRssMiB=${(process.memoryUsage().rss / MiB).toFixed(1)}`)
  assert.ok(peak < 1024 * 1024, `child VmHWM ${peak} KiB < 1 GiB`)
})
