// tests/mediaShutdown.test.js — AEGIS Drive (IDEA1) · การยกเลิกงาน media ตอน shutdown (Tranche B / B0)
//
// สัญญา: SIGTERM / service.stop() → ไม่รับงานใหม่ → AbortController ของคิว abort งานที่วิ่งอยู่ → signal ไปถึง
// probe/poster/motion → runner (เจ้าของ TERM→KILL เพียงหนึ่งเดียว) ฆ่า child → tmp ถูกลบ → stop() รอจนงานที่วิ่งอยู่
// เก็บกวาดเสร็จจึงค่อย resolve — และการยกเลิกเพราะ shutdown "ไม่ใช่" ความล้มเหลวถาวร: ไม่บันทึก GENERATION_FAILED
// ไม่นับ attempt ให้โหดขึ้น ปล่อยให้ derivative หายไป/PENDING แล้วโปรเซสถัดไปสร้างใหม่
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDerivativeService, MEDIA_STATE } from '../server/media/derivatives.js'
import { createMediaCache } from '../server/media/cache.js'
import { createJobQueue, PRIORITY } from '../server/media/queue.js'
import { createEvictor } from '../server/media/eviction.js'
import { createProcessRunner } from '../server/media/processRunner.js'
import { generatePoster, MediaJobError } from '../server/media/poster.js'
import { generateMotion } from '../server/media/motion.js'
import { probeMedia } from '../server/media/probe.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { CAPABILITIES_NONE } from '../server/media/capabilities.js'

const SHA_A = 'a'.repeat(64)
const capsFull = Object.freeze({
  ...CAPABILITIES_NONE, enabled: true, ffmpeg: { ok: true, version: '8.0' }, ffprobe: { ok: true, version: '8.0' },
  encoders: { libx264: true, libwebp: true }, decoders: { gif: true, apng: true, webp: true, webpAnimated: true, av1: true, h264: true, vp8: true, vp9: true },
  demuxers: { webp: true }, sharp: { ok: true, version: '0.35.4', avif: true },
})
let base, storageRoot
before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-shutdown-'))
  storageRoot = path.join(base, 'datalake')
  await fs.mkdir(path.join(storageRoot, 'uploads'), { recursive: true })
  await fs.writeFile(path.join(storageRoot, 'uploads', 'clip.bin'), 'original-bytes')
})
after(async () => {
  for (let i = 0; i < 20; i += 1) {
    try { await fs.rm(base, { recursive: true, force: true }); return } catch (err) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err; await new Promise((r) => setTimeout(r, 100)) }
  }
})
const row = (over = {}) => ({ id: '10', name: 'clip.gif', kind: 'file', vault: false, sha256: SHA_A, path: 'uploads/clip.bin', size: 1234, ownerId: '2', ...over })
const animProbe = { probeVersion: 1, family: 'gif', width: 800, height: 450, pixels: 360_000, durationSeconds: 3, frames: 12, animated: true, animationEvidence: 'gif-second-packet', posterOnly: false, unsupported: false, reason: null, engine: 'ffprobe' }
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** service จริงบน tmp + generator ปลอมที่ "ค้าง" จนกว่า signal จะ abort — บันทึก signal ที่ได้รับและสถานะ tmp */
async function makeService({ posterHang = true } = {}) {
  const dir = await fs.mkdtemp(path.join(base, 'cache-'))
  const limits = mediaLimitsFromEnv({ MEDIA_CACHE_DIR: dir.replace(/\\/g, '/') })
  const cache = createMediaCache({ root: dir, profile: limits.profile, storageRoot })
  const queue = createJobQueue({ concurrency: limits.workers, maxDepth: limits.queueMax })
  const evictor = createEvictor({ cache, cacheForProfile: () => cache, limits, isPinned: () => false })
  const seen = { probeSignal: null, posterSignal: null, motionSignal: null, posterTmp: null, posterStarted: deferred(), posterCleanupDone: false, cleanupOrder: [] }
  const generators = {
    probe: async (o) => { seen.probeSignal = o.signal ?? null; return animProbe },
    poster: async (o) => {
      seen.posterSignal = o.signal ?? null
      seen.posterTmp = o.tmpPath
      await fs.writeFile(o.tmpPath, 'partial')
      seen.posterStarted.resolve()
      if (!posterHang) return { file: 'poster.webp', mime: 'image/webp', width: 640, height: 360, bytes: 7, engine: 'sharp' }
      // เลียนแบบ child ที่ทำงานอยู่: จบก็ต่อเมื่อ signal abort แล้วเก็บกวาดช้า ๆ (stop ต้องรอถึงตรงนี้)
      await new Promise((resolve) => { if (o.signal?.aborted) resolve(); else o.signal?.addEventListener('abort', resolve, { once: true }) })
      await sleep(80)
      seen.cleanupOrder.push('generator-cleanup')
      seen.posterCleanupDone = true
      throw new MediaJobError({ class: 'CANCELLED', reason: 'SHUTDOWN' })
    },
    motion: async (o) => { seen.motionSignal = o.signal ?? null; await fs.writeFile(o.tmpPath, 'mp4'); return { file: 'motion.mp4', mime: 'video/mp4', width: 480, height: 270, fps: 12, seconds: 3, bytes: 3, engine: 'ffmpeg' } },
  }
  const resolver = (key) => path.resolve(storageRoot, key)
  const service = createDerivativeService({
    limits, capabilities: capsFull, cache, queue, evictor, runner: { run: async () => { throw new Error('no child in this suite') } },
    resolveStorageKey: resolver, keyExists: async () => true, sharp: null, log: () => {}, statfs: async () => ({ bavail: 1e6, bsize: 4096 }),
    mountState: 'volume', generators,
  })
  await service.init()
  await service.start()
  return { service, cache, queue, seen, dir }
}

test('B0-1 a running poster job receives the queue AbortSignal on service.stop() (probe too)', async () => {
  const s = await makeService()
  await s.service.info(row())
  await s.seen.posterStarted.promise
  assert.ok(s.seen.probeSignal instanceof AbortSignal, 'probe generator received a signal')
  assert.ok(s.seen.posterSignal instanceof AbortSignal, 'poster generator received a signal')
  assert.equal(s.seen.posterSignal.aborted, false)
  const stopping = s.service.stop()
  assert.equal(s.seen.posterSignal.aborted, true, 'stop() aborts the running job synchronously via the queue controller')
  await stopping
})

test('B0-4 stop() waits until the running job has finished its cleanup; B0-5 the tmp output is removed; B0-6 no GENERATION_FAILED persisted', async () => {
  const s = await makeService()
  await s.service.info(row())
  await s.seen.posterStarted.promise
  // ยังไม่มี state.json ก่อนงานแรกจบ = ค่าเริ่มต้น PENDING/attempts 0 (service เขียนเฉพาะเมื่อมีผล)
  const stateBefore = (await s.cache.readState(SHA_A)) ?? { poster: { state: MEDIA_STATE.PENDING, attempts: 0 } }
  assert.equal(await fs.stat(s.seen.posterTmp).then(() => true, () => false), true, 'tmp exists while running')
  await s.service.stop()
  assert.equal(s.seen.posterCleanupDone, true, 'stop() resolved only after the generator finished cleaning up')
  assert.equal(await fs.stat(s.seen.posterTmp).then(() => true, () => false), false, 'tmp removed by writeAtomic')
  const state = (await s.cache.readState(SHA_A)) ?? { poster: { state: MEDIA_STATE.PENDING, attempts: 0 } }
  assert.notEqual(state.poster.state, MEDIA_STATE.GENERATION_FAILED)
  assert.notEqual(state.poster.state, MEDIA_STATE.RETRYABLE, 'shutdown cancellation is not a retry-counted failure')
  assert.equal(state.poster.attempts ?? 0, stateBefore.poster.attempts ?? 0, 'attempt counter not incremented by shutdown')
  assert.equal(state.poster.state, MEDIA_STATE.PENDING)
  assert.equal(await s.cache.statDerivative(SHA_A, 'poster'), null, 'no half-written derivative promoted')
})

test('B0-7 no new work is accepted after stop(): scheduleForFile/ensure return false, info reports RETRYABLE without enqueuing', async () => {
  const s = await makeService({ posterHang: false })
  await s.service.stop()
  assert.equal(await s.service.scheduleForFile(row(), PRIORITY.UPLOAD), false)
  assert.equal(await s.service.ensure(row(), 'poster'), false)
  const info = await s.service.info(row())
  assert.notEqual(info.status, 'READY')
  assert.equal(s.queue.size(), 0)
  assert.equal(s.queue.isShutdown(), true)
})

test('B0-3 queue shutdown aborts a real child through processRunner (TERM→KILL owner), and B0-2 the motion generator forwards the signal', async () => {
  // สองส่วน: (ก) child จริงบนคิว — shutdown → run() คืน killed:true โดยไม่มี timedOut; (ข) generateMotion ส่ง signal ต่อให้ runner
  const runner = createProcessRunner()
  const queue = createJobQueue({ concurrency: 1, maxDepth: 10 })
  let result = null
  const started = deferred()
  const { promise } = queue.enqueue('child', PRIORITY.INTERACTIVE, async ({ signal }) => {
    const p = runner.run({ bin: process.execPath, args: ['-e', 'setInterval(() => {}, 1000); console.log("up")'], timeoutMs: 20_000, killGraceMs: 500, signal })
    started.resolve()
    result = await p
    return result
  })
  await started.promise
  await sleep(300)
  const t0 = Date.now()
  await queue.shutdown({ reason: 'stop' })
  await promise.catch(() => {})
  assert.ok(result, 'runner settled after shutdown')
  assert.equal(result.killed, true)
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - t0 < 5000, 'child terminated within the grace window, not the 20 s timeout')

  const seen = { signal: undefined }
  // เหมือน processRunner จริง: signal ที่ abort แล้ว → child ถูก TERM ทันที → resolve ด้วย killed:true (ไม่ throw)
  const fakeRunner = { run: async ({ signal }) => { seen.signal = signal; return { code: null, signal: 'SIGTERM', killed: true, timedOut: false, stdout: '', stderr: '' } } }
  const ctrl = new AbortController()
  const limits = mediaLimitsFromEnv({})
  const tmpPath = path.join(base, 'motion-cancel.mp4')
  ctrl.abort(new Error('stop'))
  await assert.rejects(
    generateMotion({ absPath: path.join(storageRoot, 'uploads', 'clip.bin'), probe: animProbe, tmpPath, limits, capabilities: capsFull, runner: fakeRunner, signal: ctrl.signal }),
    (err) => err instanceof MediaJobError && err.class === 'CANCELLED',
  )
  assert.equal(seen.signal, ctrl.signal, 'generateMotion passes the very same signal to runner.run')
})

test('B0-2b generatePoster (ffmpeg path) and probeMedia forward the signal to runner.run and surface cancellation, not a permanent failure', async () => {
  const seen = []
  const ctrl = new AbortController()
  const fakeRunner = { run: async ({ signal }) => { seen.push(signal); ctrl.abort(new Error('stop')); return { code: null, signal: 'SIGTERM', killed: true, timedOut: false, stdout: '', stderr: '' } } }
  const limits = mediaLimitsFromEnv({})
  const tmpPath = path.join(base, 'poster-cancel.webp')
  await assert.rejects(
    generatePoster({ absPath: path.join(storageRoot, 'uploads', 'clip.bin'), probe: animProbe, tmpPath, limits, capabilities: capsFull, runner: fakeRunner, sharp: null, signal: ctrl.signal }),
    (err) => err instanceof MediaJobError && err.class === 'CANCELLED' && err.reason === 'SHUTDOWN',
  )
  assert.equal(seen[0], ctrl.signal)
  assert.equal(await fs.stat(tmpPath).then(() => true, () => false), false, 'poster tmp removed on cancellation')

  const ctrl2 = new AbortController()
  const probeRunner = { run: async ({ signal }) => { seen.push(signal); ctrl2.abort(new Error('stop')); return { code: null, signal: 'SIGTERM', killed: true, timedOut: false, stdout: '', stderr: '' } } }
  const gifPath = path.join(base, 'probe-cancel.gif')
  await fs.writeFile(gifPath, Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(64)]))
  await assert.rejects(
    probeMedia({ absPath: gifPath, ext: 'gif', limits, capabilities: capsFull, runner: probeRunner, signal: ctrl2.signal }),
    (err) => err instanceof MediaJobError && err.class === 'CANCELLED',
  )
  assert.equal(seen.at(-1), ctrl2.signal)
})

test('B0-8 ordinary timeout semantics are unchanged: a timed-out runner result is still a transient TIMEOUT, never CANCELLED', async () => {
  const fakeRunner = { run: async () => ({ code: null, signal: 'SIGKILL', killed: true, timedOut: true, stdout: '', stderr: '' }) }
  const limits = mediaLimitsFromEnv({})
  const ctrl = new AbortController()
  await assert.rejects(
    generateMotion({ absPath: path.join(storageRoot, 'uploads', 'clip.bin'), probe: animProbe, tmpPath: path.join(base, 'motion-timeout.mp4'), limits, capabilities: capsFull, runner: fakeRunner, signal: ctrl.signal }),
    (err) => err instanceof MediaJobError && err.class === 'TRANSIENT' && err.reason === 'TIMEOUT',
  )
  await assert.rejects(
    generatePoster({ absPath: path.join(storageRoot, 'uploads', 'clip.bin'), probe: animProbe, tmpPath: path.join(base, 'poster-timeout.webp'), limits, capabilities: capsFull, runner: fakeRunner, sharp: null, signal: ctrl.signal }),
    (err) => err instanceof MediaJobError && err.class === 'TRANSIENT' && err.reason === 'TIMEOUT',
  )
  // ไม่มี signal เลย (ผู้เรียกเก่า) ก็ยังทำงานเหมือนเดิม
  await assert.rejects(
    generateMotion({ absPath: path.join(storageRoot, 'uploads', 'clip.bin'), probe: animProbe, tmpPath: path.join(base, 'motion-timeout2.mp4'), limits, capabilities: capsFull, runner: fakeRunner }),
    (err) => err instanceof MediaJobError && err.reason === 'TIMEOUT',
  )
})

test('B0-STATIC derivatives.js hands the queue signal to runJob and stop() drains; no second kill implementation exists', async () => {
  const src = await fs.readFile(new URL('../server/media/derivatives.js', import.meta.url), 'utf8')
  assert.match(src, /\(\{ signal \}\) => runJob\(/, 'enqueue passes the queue AbortSignal into runJob')
  assert.doesNotMatch(src, /\.kill\(/, 'derivatives never kills processes itself')
  for (const f of ['../server/media/poster.js', '../server/media/motion.js', '../server/media/probe.js']) {
    const g = await fs.readFile(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(g, /\.kill\(|SIGKILL/, `${f}: processRunner remains the single TERM→KILL owner`)
  }
})
