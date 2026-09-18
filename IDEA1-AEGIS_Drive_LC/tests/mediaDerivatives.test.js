// tests/mediaDerivatives.test.js — AEGIS Drive (IDEA1) · derivative service state machine (Task 7)
//
// ⚠️ spec §12–§14, §17, §19, §22: ตัวตน = sha256 + profile + ชนิด; probe → poster → motion (ถ้าพิสูจน์ว่าเคลื่อนไหว);
//    คิว dedup + ลำดับความสำคัญ; retry 3 ครั้ง / 4 attempts (1 → 5 → 30 นาที); ถาวรไม่วนซ้ำ; พื้นที่สำรอง;
//    vault/โฟลเดอร์ = NOT_FOUND และไม่มีวันถูก probe; ไม่มี sha = NO_CONTENT_IDENTITY; ต้นฉบับผ่าน resolver ที่ inject
//    เท่านั้น; cache สร้างใหม่ได้เสมอ. generator ทุกตัวเป็นของปลอม — ไม่ต้องมี ffmpeg/sharp
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDerivativeService, MEDIA_STATE, MAX_TRANSIENT_RETRIES, MAX_TOTAL_ATTEMPTS, RETRY_BACKOFF_MS } from '../server/media/derivatives.js'
import { createMediaCache } from '../server/media/cache.js'
import { createJobQueue, PRIORITY } from '../server/media/queue.js'
import { createEvictor } from '../server/media/eviction.js'
import { MediaJobError } from '../server/media/poster.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { CAPABILITIES_NONE } from '../server/media/capabilities.js'
import { PREVIEW_MIME } from '../server/config/previewMedia.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const capsFull = Object.freeze({
  ...CAPABILITIES_NONE, enabled: true, ffmpeg: { ok: true, version: '8.0' }, ffprobe: { ok: true, version: '8.0' },
  encoders: { libx264: true, libwebp: true }, decoders: { gif: true, apng: true, webp: true, webpAnimated: true, av1: true, h264: true, vp8: true, vp9: true },
  demuxers: { webp: true }, sharp: { ok: true, version: '0.35.4', avif: true },
})
let base, storageRoot, cacheRoot
before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-service-'))
  storageRoot = path.join(base, 'datalake'); cacheRoot = path.join(base, 'cache')
  await fs.mkdir(path.join(storageRoot, 'uploads'), { recursive: true })
})
after(async () => {
  for (let i = 0; i < 20; i += 1) {
    try { await fs.rm(base, { recursive: true, force: true }); return } catch (err) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err; await new Promise((r) => setTimeout(r, 100)) }
  }
})

const row = (over = {}) => ({ id: '10', name: 'clip.gif', kind: 'file', vault: false, sha256: SHA_A, path: 'uploads/clip.bin', size: 1234, ownerId: '2', ...over })
const stillProbe = { probeVersion: 1, family: 'png', width: 800, height: 450, pixels: 360_000, durationSeconds: null, frames: null, animated: false, animationEvidence: 'png-no-actl', posterOnly: false, unsupported: false, reason: null, engine: 'header' }
const animProbe = { ...stillProbe, family: 'gif', animated: true, animationEvidence: 'gif-second-packet', frames: 12, durationSeconds: 3 }
const unknownProbe = { ...stillProbe, family: 'webp', animated: null, animationEvidence: 'webp-vp8x-flag-pages-unproven', posterOnly: true }

/** สร้าง service จริง (cache/queue/evictor จริงบน tmp) + generator ปลอมที่ควบคุมได้ */
async function makeService({ probe = animProbe, posterImpl, motionImpl, limitsEnv = {}, statfsFree = 10 * 1024 ** 3, clock } = {}) {
  const dir = await fs.mkdtemp(path.join(cacheRoot + '-', ''))
  const limits = mediaLimitsFromEnv({ MEDIA_CACHE_DIR: dir.replace(/\\/g, '/'), ...limitsEnv })
  const cache = createMediaCache({ root: dir, profile: limits.profile, storageRoot })
  const queue = createJobQueue({ concurrency: limits.workers, maxDepth: limits.queueMax })
  let nowMs = clock ?? Date.parse('2026-09-18T12:00:00.000Z')
  const now = () => nowMs
  const evictor = createEvictor({ cache, cacheForProfile: () => cache, limits, now, isPinned: (sha) => service.isPinned(sha) })
  const calls = { probe: [], poster: [], motion: [] }
  const generators = {
    probe: async (o) => { calls.probe.push(o); return typeof probe === 'function' ? probe(o) : probe },
    poster: async (o) => { calls.poster.push(o); if (posterImpl) return posterImpl(o); await fs.writeFile(o.tmpPath, 'poster'); return { file: 'poster.webp', mime: 'image/webp', width: 640, height: 360, bytes: 6, engine: 'sharp' } },
    motion: async (o) => { calls.motion.push(o); if (motionImpl) return motionImpl(o); await fs.writeFile(o.tmpPath, 'mp4mp4'); return { file: 'motion.mp4', mime: 'video/mp4', width: 480, height: 270, fps: 12, seconds: 3, bytes: 6, engine: 'ffmpeg' } },
  }
  await fs.writeFile(path.join(storageRoot, 'uploads', 'clip.bin'), 'original-bytes')
  const resolver = (key) => { const abs = path.resolve(storageRoot, key); return abs.startsWith(storageRoot + path.sep) ? abs : null }
  const keyExists = async (key) => { const abs = resolver(key); if (!abs) return false; try { await fs.access(abs); return true } catch { return false } }
  const audits = []
  const service = createDerivativeService({
    limits, capabilities: capsFull, cache, queue, evictor, runner: { run: async () => { throw new Error('no child in this suite') } },
    resolveStorageKey: resolver, keyExists, sharp: null, now, log: () => {}, statfs: async () => ({ bavail: Math.floor(statfsFree / 4096), bsize: 4096 }),
    mountState: 'volume', generators, onAudit: (e) => audits.push(e),
  })
  await service.init()
  return { service, cache, queue, evictor, calls, limits, audits, dir, tick: (ms) => { nowMs += ms }, settle: () => service.drain() }
}

test('DS-1 cold cache: info() is PENDING and enqueues exactly one probe→poster chain', async () => {
  const s = await makeService()
  const info = await s.service.info(row())
  assert.equal(info.status, 'PENDING')
  assert.equal(info.poster.state, MEDIA_STATE.PENDING)
  assert.ok(info.poster.retryAfterMs >= 1000)
  assert.equal(info.sourceVersion, SHA_A)
  assert.equal(info.profile, 'v1')
  assert.equal(s.queue.has(`v1/${SHA_A}/poster`), true)
  await s.settle()
  assert.equal(s.calls.probe.length, 1)
  assert.equal(s.calls.poster.length, 1)
})

test('DS-2 after generation: READY info carries opaque URLs with v + p, ETags, dimensions; motion follows for animated sources', async () => {
  const s = await makeService()
  await s.service.info(row()); await s.settle()
  const info = await s.service.info(row())
  assert.equal(info.status, 'READY')
  assert.equal(info.poster.state, 'READY')
  assert.equal(info.poster.url, `/api/files/10/poster?v=${SHA_A}&p=v1`)
  assert.equal(info.poster.etag, `"${SHA_A}-v1-poster"`)
  assert.deepEqual([info.poster.width, info.poster.height, info.poster.mime], [640, 360, 'image/webp'])
  assert.equal(info.motion.state, 'READY')
  assert.equal(info.motion.url, `/api/files/10/motion-preview?v=${SHA_A}&p=v1`)
  assert.equal(info.motion.etag, `"${SHA_A}-v1-motion"`)
  assert.deepEqual([info.family, info.animated, info.width, info.height, info.durationSeconds], ['gif', true, 800, 450, 3])
  assert.equal(s.calls.motion.length, 1)
  const state = await s.cache.readState(SHA_A)
  assert.equal(state.poster.state, 'READY'); assert.equal(state.motion.state, 'READY'); assert.equal(state.poster.attempts, 1)
  assert.ok((await fs.stat(s.cache.paths(SHA_A).poster('webp'))).size > 0)
  assert.ok((await fs.stat(s.cache.paths(SHA_A).motion)).size > 0)
})

test('DS-3 still image: motion UNSUPPORTED / NOT_ANIMATED and status READY once the poster exists; no motion job', async () => {
  const s = await makeService({ probe: stillProbe })
  await s.service.info(row({ name: 'photo.png' })); await s.settle()
  const info = await s.service.info(row({ name: 'photo.png' }))
  assert.equal(info.status, 'READY')
  assert.deepEqual([info.motion.state, info.motion.reason, info.motion.url], ['UNSUPPORTED', 'NOT_ANIMATED', null])
  assert.equal(s.calls.motion.length, 0)
})

test('DS-4 animation unknown: poster generated, motion UNSUPPORTED / ANIMATION_UNKNOWN, animated null', async () => {
  const s = await makeService({ probe: unknownProbe })
  await s.service.info(row({ name: 'a.webp' })); await s.settle()
  const info = await s.service.info(row({ name: 'a.webp' }))
  assert.equal(info.poster.state, 'READY')
  assert.equal(info.animated, null)
  assert.deepEqual([info.motion.state, info.motion.reason], ['UNSUPPORTED', 'ANIMATION_UNKNOWN'])
  assert.equal(s.calls.motion.length, 0)
})

test('DS-5 vault rows are NOT_FOUND and never probed/generated/scheduled — defence in depth independent of routes', async () => {
  const s = await makeService()
  const vault = row({ vault: true })
  assert.deepEqual(await s.service.info(vault), { status: 'NOT_FOUND' })
  assert.equal(await s.service.ensure(vault, 'poster', PRIORITY.INTERACTIVE), false)
  assert.equal(await s.service.scheduleForFile(vault, PRIORITY.UPLOAD), false)
  assert.deepEqual(await s.service.serve(vault, 'poster', { v: SHA_A, p: 'v1' }), { kind: 'stale' })
  await s.settle()
  assert.deepEqual([s.calls.probe.length, s.calls.poster.length, s.calls.motion.length], [0, 0, 0])
  assert.equal(s.queue.size(), 0)
})

test('DS-6 folder rows are NOT_FOUND; rows without sha256 are UNSUPPORTED / NO_CONTENT_IDENTITY; nothing enqueued', async () => {
  const s = await makeService()
  assert.deepEqual(await s.service.info(row({ kind: 'folder', sha256: null })), { status: 'NOT_FOUND' })
  const noSha = await s.service.info(row({ sha256: null }))
  assert.deepEqual([noSha.status, noSha.reason], ['UNSUPPORTED', 'NO_CONTENT_IDENTITY'])
  assert.deepEqual([(await s.service.info(row({ sha256: '' }))).reason, (await s.service.info(row({ sha256: 'Z'.repeat(64) }))).reason], ['NO_CONTENT_IDENTITY', 'NO_CONTENT_IDENTITY'])
  assert.equal(await s.service.scheduleForFile(row({ sha256: null }), PRIORITY.UPLOAD), false)
  assert.equal(s.queue.size(), 0)
})

test('DS-7 extension outside the allowlist → UNSUPPORTED / UNSUPPORTED_TYPE via config/previewMedia.js; the service never imports routes/api.js', async () => {
  const s = await makeService()
  const info = await s.service.info(row({ name: 'notes.txt' }))
  assert.deepEqual([info.status, info.reason], ['UNSUPPORTED', 'UNSUPPORTED_TYPE'])
  assert.equal(await s.service.scheduleForFile(row({ name: 'notes.txt' }), PRIORITY.UPLOAD), false)
  assert.equal(s.queue.size(), 0)
  for (const ext of Object.keys(PREVIEW_MIME)) assert.notEqual((await s.service.info(row({ name: `x.${ext}` }))).reason, 'UNSUPPORTED_TYPE', ext)
  await s.settle()
  const src = await fs.readFile(new URL('../server/media/derivatives.js', import.meta.url), 'utf8')
  assert.match(src, /from '\.\.\/config\/previewMedia\.js'/)
  assert.doesNotMatch(src, /routes\/api\.js|storage\/fileStore\.js|db\/store\.js/, 'no route/store/storage imports — rows and the resolver are injected')
})

test('DS-8 identical bytes across different rows/owners share one job and one entry', async () => {
  const s = await makeService()
  const r1 = row({ id: '1', name: 'a.gif', ownerId: '2' })
  const r2 = row({ id: '2', name: 'b.gif', ownerId: '3' })
  await s.service.info(r1); await s.service.info(r2)
  await s.settle()
  assert.equal(s.calls.probe.length, 1); assert.equal(s.calls.poster.length, 1)
  assert.equal((await s.service.info(r1)).status, 'READY'); assert.equal((await s.service.info(r2)).status, 'READY')
})

test('DS-9 / RETRY-1 transient, transient, success → attempts 3, READY; backoff 60 s then 300 s', async () => {
  let n = 0
  const s = await makeService({ posterImpl: async (o) => { n += 1; if (n < 3) throw new MediaJobError({ class: 'TRANSIENT', reason: 'TIMEOUT' }); await fs.writeFile(o.tmpPath, 'p'); return { file: 'poster.webp', mime: 'image/webp', width: 1, height: 1, bytes: 1, engine: 'sharp' } } })
  await s.service.info(row()); await s.settle()
  let st = await s.cache.readState(SHA_A)
  assert.deepEqual([st.poster.state, st.poster.attempts], ['RETRYABLE', 1])
  assert.equal(Date.parse(st.poster.nextRetryAt), Date.parse('2026-09-18T12:00:00.000Z') + RETRY_BACKOFF_MS[0])
  assert.equal(RETRY_BACKOFF_MS[0], 60_000)
  s.tick(60_000); await s.service.info(row()); await s.settle()
  st = await s.cache.readState(SHA_A)
  assert.deepEqual([st.poster.state, st.poster.attempts], ['RETRYABLE', 2])
  assert.equal(Date.parse(st.poster.nextRetryAt), Date.parse('2026-09-18T12:01:00.000Z') + RETRY_BACKOFF_MS[1])
  assert.equal(RETRY_BACKOFF_MS[1], 300_000)
  s.tick(300_000); await s.service.info(row()); await s.settle()
  st = await s.cache.readState(SHA_A)
  assert.deepEqual([st.poster.state, st.poster.attempts], ['READY', 3])
})

test('DS-9 / RETRY-2 transient × 4 → attempts 4, GENERATION_FAILED; never a fifth attempt', async () => {
  let n = 0
  const s = await makeService({ posterImpl: async () => { n += 1; throw new MediaJobError({ class: 'TRANSIENT', reason: 'TIMEOUT' }) } })
  assert.deepEqual([MAX_TRANSIENT_RETRIES, MAX_TOTAL_ATTEMPTS, RETRY_BACKOFF_MS], [3, 4, [60_000, 300_000, 1_800_000]])
  await s.service.info(row()); await s.settle()
  for (const wait of [60_000, 300_000, 1_800_000]) { s.tick(wait); await s.service.info(row()); await s.settle() }
  let st = await s.cache.readState(SHA_A)
  assert.deepEqual([st.poster.state, st.poster.attempts, st.poster.reason], ['GENERATION_FAILED', 4, 'TIMEOUT'])
  s.tick(24 * 3_600_000); await s.service.info(row()); await s.settle()
  assert.equal(n, 4, 'no fifth attempt after 24 h')
  const info = await s.service.info(row())
  assert.deepEqual([info.status, info.poster.state, info.poster.reason], ['GENERATION_FAILED', 'GENERATION_FAILED', 'TIMEOUT'])
})

test('DS-9 / RETRY-3 no attempt before nextRetryAt: info reports RETRYABLE with retryAfterMs; at nextRetryAt exactly one job', async () => {
  let n = 0
  const s = await makeService({ posterImpl: async () => { n += 1; throw new MediaJobError({ class: 'TRANSIENT', reason: 'DISK' }) } })
  await s.service.info(row()); await s.settle()
  assert.equal(n, 1)
  s.tick(59_000)
  const early = await s.service.info(row())
  assert.deepEqual([early.status, early.poster.state, early.poster.retryAfterMs], ['RETRYABLE', 'RETRYABLE', 1000])
  await s.settle(); assert.equal(n, 1, 'not retried before nextRetryAt')
  s.tick(1000)
  await s.service.info(row()); await s.service.info(row())
  assert.equal(s.queue.size() <= 1, true)
  await s.settle(); assert.equal(n, 2, 'exactly one retry at nextRetryAt')
})

test('DS-9 / RETRY-4 PERMANENT on attempt 1 → attempts 1, GENERATION_FAILED, no retry; probe-level unsupported → UNSUPPORTED', async () => {
  let n = 0
  const s = await makeService({ posterImpl: async () => { n += 1; throw new MediaJobError({ class: 'PERMANENT', reason: 'DECODE_FAILED' }) } })
  await s.service.info(row()); await s.settle()
  const st = await s.cache.readState(SHA_A)
  assert.deepEqual([st.poster.state, st.poster.attempts, st.poster.reason, st.poster.nextRetryAt], ['GENERATION_FAILED', 1, 'DECODE_FAILED', null])
  s.tick(3 * 3_600_000); await s.service.info(row()); await s.settle()
  assert.equal(n, 1)
  const u = await makeService({ probe: { unsupported: true, reason: 'FAMILY_MISMATCH', family: 'png' } })
  await u.service.info(row({ name: 'fake.jpg' })); await u.settle()
  const ui = await u.service.info(row({ name: 'fake.jpg' }))
  assert.deepEqual([ui.status, ui.reason, ui.poster.state], ['UNSUPPORTED', 'FAMILY_MISMATCH', 'UNSUPPORTED'])
  assert.equal(u.calls.poster.length, 0)
})

test('DS-10 serve(): ready descriptor with etag; stale v / non-current p → stale; missing v → bad-request; pending/unsupported/failed/retryable kinds', async () => {
  const s = await makeService()
  assert.deepEqual(await s.service.serve(row(), 'poster', { v: null, p: 'v1' }), { kind: 'bad-request' })
  assert.deepEqual(await s.service.serve(row(), 'poster', { v: SHA_A, p: '' }), { kind: 'bad-request' })
  assert.deepEqual(await s.service.serve(row(), 'poster', { v: SHA_B, p: 'v1' }), { kind: 'stale' })
  assert.deepEqual(await s.service.serve(row(), 'poster', { v: SHA_A, p: 'v0' }), { kind: 'stale' })
  const pending = await s.service.serve(row(), 'poster', { v: SHA_A, p: 'v1' })
  assert.equal(pending.kind, 'pending'); assert.ok(pending.retryAfterSeconds >= 1)
  await s.settle()
  const ready = await s.service.serve(row(), 'poster', { v: SHA_A, p: 'v1' })
  assert.deepEqual([ready.kind, ready.mime, ready.etag, ready.bytes], ['ready', 'image/webp', `"${SHA_A}-v1-poster"`, 6])
  assert.equal(ready.path, s.cache.paths(SHA_A).poster('webp'))
  const motion = await s.service.serve(row(), 'motion', { v: SHA_A, p: 'v1' })
  assert.deepEqual([motion.kind, motion.mime, motion.etag], ['ready', 'video/mp4', `"${SHA_A}-v1-motion"`])
  const still = await makeService({ probe: stillProbe })
  await still.service.info(row({ name: 'p.png' })); await still.settle()
  assert.deepEqual(await still.service.serve(row({ name: 'p.png' }), 'motion', { v: SHA_A, p: 'v1' }), { kind: 'unsupported', reason: 'NOT_ANIMATED' })
  assert.deepEqual(await still.service.serve(row({ name: 'notes.txt' }), 'poster', { v: SHA_A, p: 'v1' }), { kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' })
  const failed = await makeService({ posterImpl: async () => { throw new MediaJobError({ class: 'PERMANENT', reason: 'DECODE_FAILED' }) } })
  await failed.service.info(row()); await failed.settle()
  assert.deepEqual(await failed.service.serve(row(), 'poster', { v: SHA_A, p: 'v1' }), { kind: 'failed', reason: 'DECODE_FAILED' })
  const retry = await makeService({ posterImpl: async () => { throw new MediaJobError({ class: 'TRANSIENT', reason: 'TIMEOUT' }) } })
  await retry.service.info(row()); await retry.settle()
  const r = await retry.service.serve(row(), 'poster', { v: SHA_A, p: 'v1' })
  assert.equal(r.kind, 'retryable'); assert.equal(r.retryAfterSeconds, 60)
})

test('DS-11 serving touches lastAccess and pins the entry for the eviction pass', async () => {
  const s = await makeService()
  await s.service.info(row()); await s.settle()
  await s.service.serve(row(), 'poster', { v: SHA_A, p: 'v1' })
  assert.equal(s.cache.lastAccessOf(SHA_A), Date.parse('2026-09-18T12:00:00.000Z'))
  assert.equal(s.evictor.entries().find((e) => e.sha === SHA_A).lastAccess, Date.parse('2026-09-18T12:00:00.000Z'))
  assert.equal(s.service.isPinned(SHA_A), false, 'no job in flight')
})

test('DS-12 disk reserve: free space below cacheFreeReserveBytes → RETRYABLE / DISK, nothing generated', async () => {
  const s = await makeService({ statfsFree: 100 * 1024 * 1024 })
  const info = await s.service.info(row())
  assert.deepEqual([info.status, info.poster.state, info.poster.reason, info.poster.retryAfterMs], ['RETRYABLE', 'RETRYABLE', 'DISK', 60_000])
  await s.settle()
  assert.equal(s.calls.probe.length, 0)
})

test('DS-13 queue full → RETRYABLE / QUEUE_FULL without enqueueing; the existing job still completes', async () => {
  const s = await makeService({ limitsEnv: { MEDIA_QUEUE_MAX: '1' } })
  await s.service.info(row({ id: '1', sha256: SHA_A }))
  const second = await s.service.info(row({ id: '2', name: 'other.gif', sha256: SHA_B }))
  assert.deepEqual([second.status, second.poster.reason], ['RETRYABLE', 'QUEUE_FULL'])
  await s.settle()
  assert.equal(s.calls.poster.length, 1)
})

test('DS-14 eviction regeneration: after the entry is removed, info() is PENDING again and a new job runs', async () => {
  const s = await makeService()
  await s.service.info(row()); await s.settle()
  assert.equal((await s.service.info(row())).status, 'READY')
  await s.cache.removeEntry(SHA_A); s.evictor.remove(SHA_A)
  const again = await s.service.info(row())
  assert.equal(again.status, 'PENDING')
  await s.settle()
  assert.equal(s.calls.poster.length, 2)
  assert.equal((await s.service.info(row())).status, 'READY')
})

test('DS-15 stale profile: a v0 entry is never served (p mismatch) and is listed for eviction first', async () => {
  const s = await makeService()
  const v0 = createMediaCache({ root: s.cache.root, profile: 'v0', storageRoot })
  await v0.writeAtomic(v0.paths(SHA_A).poster('webp'), (t) => fs.writeFile(t, 'old'))
  await v0.writeState(SHA_A, { profile: 'v0', sha256: SHA_A, poster: { state: 'READY', file: 'poster.webp', mime: 'image/webp', width: 1, height: 1, bytes: 3, attempts: 1 }, motion: { state: 'PENDING', attempts: 0, nextRetryAt: null, reason: null }, lastAccess: '2026-09-18T11:00:00.000Z' })
  assert.deepEqual(await s.service.serve(row(), 'poster', { v: SHA_A, p: 'v0' }), { kind: 'stale' })
  assert.deepEqual(await s.cache.staleProfileDirs(), ['v0'])
  const status = await s.service.adminStatus()
  assert.deepEqual(status.cache.staleProfiles, ['v0'])
})

test('DS-16 invalidate(): removes the entry, resets attempts, audits; adminStatus() is aggregate only (no file names)', async () => {
  const s = await makeService({ posterImpl: async () => { throw new MediaJobError({ class: 'PERMANENT', reason: 'DECODE_FAILED' }) } })
  await s.service.info(row({ name: 'secret-name-xyz.gif' })); await s.settle()
  assert.equal((await s.service.info(row({ name: 'secret-name-xyz.gif' }))).status, 'GENERATION_FAILED')
  assert.equal(await s.service.invalidate(SHA_A, { actor: 'admin' }), true)
  assert.deepEqual(s.audits.at(-1), { action: 'MEDIA_CACHE_INVALIDATE', target: SHA_A, actor: 'admin' })
  assert.equal(await s.cache.readState(SHA_A), null)
  const after = await s.service.info(row({ name: 'secret-name-xyz.gif' }))
  assert.equal(after.status, 'PENDING', 'one fresh attempt is allowed after invalidation')
  assert.equal(await s.service.invalidate('not-a-sha'), false)
  const status = await s.service.adminStatus()
  for (const key of ['enabled', 'capabilities', 'cache', 'queue', 'failures']) assert.ok(Object.hasOwn(status, key), key)
  for (const key of ['dir', 'bytes', 'entries', 'highWater', 'lowWater', 'lastEvictionAt', 'staleProfiles', 'volume']) assert.ok(Object.hasOwn(status.cache, key), key)
  for (const key of ['depth', 'running', 'byPriority']) assert.ok(Object.hasOwn(status.queue, key), key)
  assert.ok(!JSON.stringify(status).includes('secret-name-xyz'))
})

test('DS-17 init()/start()/stop()/health(): tmp cleanup, index build, eviction timer; health echoes the injected mountState', async () => {
  const s = await makeService()
  const tmpDir = s.cache.paths(SHA_A).tmpDir
  await fs.mkdir(tmpDir, { recursive: true })
  const stale = path.join(tmpDir, 'old.poster.webp.tmp-dead')
  await fs.writeFile(stale, 'x'); const old = new Date(Date.now() - 3_600_000); await fs.utimes(stale, old, old)
  await s.service.start()
  await assert.rejects(fs.access(stale), { code: 'ENOENT' }, 'abandoned tmp removed at start')
  const h = s.service.health()
  assert.deepEqual([h.enabled, h.reason, h.cacheVolume, h.cacheWritable, h.ffmpeg.ok, h.sharp.ok], [true, null, 'volume', true, true, true])
  await s.service.stop()
  assert.equal(s.queue.isShutdown(), true)
  const fsSrc = await fs.readFile(new URL('../server/media/derivatives.js', import.meta.url), 'utf8')
  assert.doesNotMatch(fsSrc, /st_dev|\.dev\b|mountinfo/i, 'no mount detection inside the service — mountState is injected')
})

test('DS-18 infoBatch(): one entry per row, one job per distinct sha', async () => {
  const s = await makeService()
  const rows = [row({ id: '1', sha256: SHA_A }), row({ id: '2', name: 'dup.gif', sha256: SHA_A }), row({ id: '3', name: 'other.gif', sha256: SHA_B }), row({ id: '4', vault: true })]
  const map = await s.service.infoBatch(rows)
  assert.deepEqual([...map.keys()], ['1', '2', '3', '4'])
  assert.equal(map.get('1').status, 'PENDING'); assert.equal(map.get('4').status, 'NOT_FOUND')
  await s.settle()
  assert.deepEqual(s.calls.probe.map((c) => c.absPath).length, 2, 'one probe per distinct sha (jobs may already have run by the time the batch returns)')
})

test('DS-19 storage resolver contract: unresolvable/missing keys → UNSUPPORTED / SOURCE_MISSING with no generator call; generators receive the resolved absPath only', async () => {
  const s = await makeService()
  const escape = await s.service.info(row({ path: '../../etc/passwd' })); await s.settle()
  assert.deepEqual([escape.status, escape.reason], ['UNSUPPORTED', 'SOURCE_MISSING'])
  const missing = await s.service.info(row({ id: '11', sha256: SHA_B, path: 'uploads/nope.bin' })); await s.settle()
  assert.deepEqual([missing.status, missing.reason], ['UNSUPPORTED', 'SOURCE_MISSING'])
  assert.deepEqual([s.calls.probe.length, s.calls.poster.length], [0, 0])
  await s.service.info(row({ id: '12', sha256: 'c'.repeat(64) })); await s.settle()
  const abs = path.resolve(storageRoot, 'uploads', 'clip.bin')
  assert.equal(s.calls.probe[0].absPath, abs)
  assert.equal(s.calls.poster[0].absPath, abs)
  assert.equal(s.calls.motion[0].absPath, abs)
  for (const c of [...s.calls.probe, ...s.calls.poster, ...s.calls.motion]) assert.ok(!Object.values(c).some((v) => typeof v === 'string' && v.includes('clip.gif')), 'no row name reaches a generator')
})
