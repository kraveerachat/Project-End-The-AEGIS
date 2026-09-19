// tests/mediaRuntime.test.js — AEGIS Drive (IDEA1) · production media runtime assembly + boot sequence (Task 7)
//
// ⚠️ spec §10.4: limits → prerequisites → runner → (MEDIA_ENABLED ? detect : ไม่ spawn อะไรเลย) → runtime จริง →
//    service.init() → createApp({ mediaService }) → listen → service.start(). ไม่มี service "ตัวแทน" ที่อัปเกรดทีหลัง;
//    MEDIA_ENABLED=false / เครื่องมือหาย = disabledMediaService พร้อม reason ที่ตรวจสอบได้; sharp.concurrency(1) ครั้งเดียว
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

process.env.SESSION_SECRET ??= 'test-only-session-secret-not-used-in-production'
delete process.env.DATABASE_URL

import { bootMedia, createMediaRuntime } from '../server/media/runtime.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'
import { CAPABILITIES_NONE } from '../server/media/capabilities.js'
import { createApp } from '../server/app.js'

const REAL_LIKE_CAPS = Object.freeze({
  ...CAPABILITIES_NONE, enabled: true, ffmpeg: { ok: true, version: '8.0.1' }, ffprobe: { ok: true, version: '8.0.1' },
  encoders: { libx264: true, libwebp: true }, decoders: { gif: true, apng: true, webp: true, webpAnimated: false, av1: true, h264: true, vp8: true, vp9: true },
  demuxers: { webp: false }, sharp: { ok: true, version: '0.35.4', avif: true }, reasons: ['DEMUXER_WEBP_MISSING'],
})
let base, storageRoot
before(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-runtime-')); storageRoot = path.join(base, 'datalake'); await fs.mkdir(storageRoot, { recursive: true }) })
after(async () => { await fs.rm(base, { recursive: true, force: true }) })

function spyRunner() { const spawns = []; return { spawns, async run(o) { spawns.push(o); return { code: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1, metrics: null } } } }
function fakeSharpModule() {
  const calls = []
  const sharp = () => { throw new Error('not used here') }
  sharp.concurrency = (n) => { calls.push(n); return n }
  sharp.versions = { sharp: '0.35.4', vips: '8.18.6' }
  return { sharp, calls }
}
const envFor = (over = {}) => ({ MEDIA_CACHE_DIR: path.join(base, 'cache-' + Math.random().toString(16).slice(2)).replace(/\\/g, '/'), ...over })
const resolver = (key) => { const abs = path.resolve(storageRoot, key); return abs.startsWith(storageRoot + path.sep) ? abs : null }
const keyExists = async (key) => { try { await fs.access(resolver(key)); return true } catch { return false } }
const bootWith = (env, over = {}) => bootMedia({
  env, runner: spyRunner(), detect: async () => REAL_LIKE_CAPS, resolveStorageKey: resolver, keyExists, storageRoot,
  loadSharp: async () => fakeSharpModule().sharp, mountInfoPath: path.join(base, 'no-mountinfo'), log: () => {}, ...over,
})
async function withServer(app, fn) {
  const server = app.listen(0); await new Promise((r) => server.once('listening', r))
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally { await new Promise((r) => server.close(r)) }
}

test('BOOT-1 tools available: the injected service carries the real probed capabilities and health reports enabled', async () => {
  const env = envFor({ MEDIA_ENABLED: 'true' })
  const boot = await bootWith(env)
  assert.equal(boot.capabilities, REAL_LIKE_CAPS)
  const h = boot.service.health()
  assert.equal(h.enabled, true)
  assert.equal(h.ffmpeg.version, '8.0.1', 'probed value, not CAPABILITIES_NONE')
  assert.equal(h.cacheWritable, true)
  assert.ok(['ephemeral', 'unknown'].includes(h.cacheVolume), 'no mountinfo in this environment')
  const app = createApp({ env: { ...process.env, ...env }, mediaLimits: boot.limits, mediaService: boot.service })
  await withServer(app, async (b) => {
    const body = await (await fetch(`${b}/healthz`)).json()
    assert.equal(body.media.enabled, true)
    assert.equal(body.media.ffmpeg.version, '8.0.1')
  })
  await boot.service.stop()
})

test('BOOT-2 tools absent: boot never rejects; disabled service with reason TOOLS_MISSING; Drive stays healthy', async () => {
  const env = envFor({ MEDIA_ENABLED: 'true' })
  const boot = await bootWith(env, { detect: async () => ({ ...CAPABILITIES_NONE, reasons: ['FFMPEG_MISSING', 'FFPROBE_MISSING'] }) })
  assert.equal(boot.service.reason, 'TOOLS_MISSING')
  assert.equal(boot.service.health().enabled, false)
  assert.equal(boot.service.health().reason, 'TOOLS_MISSING')
  const app = createApp({ env: { ...process.env, ...env }, mediaLimits: boot.limits, mediaService: boot.service })
  await withServer(app, async (b) => {
    const res = await fetch(`${b}/healthz`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.media.reason, 'TOOLS_MISSING')
    assert.equal(body.ok, true)
  })
})

test('BOOT-3 MEDIA_ENABLED=false: detect is never called, nothing is spawned, no queue, scheduleForFile === false, reason MEDIA_DISABLED', async () => {
  const env = envFor({ MEDIA_ENABLED: 'false' })
  let detectCalls = 0
  const runner = spyRunner()
  const boot = await bootWith(env, { runner, detect: async () => { detectCalls += 1; return REAL_LIKE_CAPS } })
  assert.equal(detectCalls, 0)
  assert.equal(runner.spawns.length, 0)
  assert.equal(boot.service.reason, 'MEDIA_DISABLED')
  assert.equal(boot.queue, null)
  assert.equal(await boot.service.scheduleForFile({ id: '1', name: 'a.gif', kind: 'file', vault: false, sha256: 'a'.repeat(64), path: 'uploads/a.bin' }, 1), false)
  assert.deepEqual(await boot.service.info({ id: '1', name: 'a.gif', kind: 'file', vault: false, sha256: 'a'.repeat(64), path: 'uploads/a.bin' }), { status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' })
  await assert.rejects(fs.access(env.MEDIA_CACHE_DIR), { code: 'ENOENT' }, 'disabled boot creates no cache directory')
})

test('BOOT-4 createApp default (no injection) reports MEDIA_SERVICE_NOT_INJECTED and never pretends media is available', async () => {
  const app = createApp({ env: { ...process.env, MEDIA_ENABLED: 'true' } })
  const svc = app.get('mediaService')
  assert.equal(svc.health().enabled, false)
  assert.equal(svc.health().reason, 'MEDIA_SERVICE_NOT_INJECTED')
  assert.deepEqual(await svc.info({ id: '1', name: 'a.gif', kind: 'file', vault: false, sha256: 'a'.repeat(64) }), { status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' })
})

test('BOOT-5 canonical sequence trace; start() is left to index.js (after listen); sharp.concurrency(1) exactly once', async () => {
  const env = envFor({ MEDIA_ENABLED: 'true' })
  const fake = fakeSharpModule()
  const boot = await bootWith(env, { loadSharp: async () => fake.sharp })
  assert.deepEqual(boot.trace, ['limits', 'runner', 'detect', 'sharp', 'mount', 'runtime', 'init'])
  assert.deepEqual(fake.calls, [1], 'global libvips pool configured once at assembly')
  assert.equal(boot.started, false)
  await boot.service.start(); assert.equal(boot.service.isStarted(), true); await boot.service.stop()
  const disabled = await bootWith(envFor({ MEDIA_ENABLED: 'false' }))
  assert.deepEqual(disabled.trace, ['limits', 'runner', 'disabled'])
})

test('BOOT-6 createMediaRuntime wires the trusted resolver: generators see the resolved absPath; traversal keys are SOURCE_MISSING', async () => {
  await fs.mkdir(path.join(storageRoot, 'uploads'), { recursive: true })
  await fs.writeFile(path.join(storageRoot, 'uploads', 'x.bin'), 'bytes')
  const seen = []
  const limits = mediaLimitsFromEnv(envFor({ MEDIA_ENABLED: 'true' }))
  const service = createMediaRuntime({
    limits, capabilities: REAL_LIKE_CAPS, runner: spyRunner(), resolveStorageKey: resolver, keyExists, storageRoot, sharp: null, log: () => {}, mountState: 'volume',
    generators: {
      probe: async (o) => { seen.push(o.absPath); return { probeVersion: 1, family: 'png', width: 4, height: 4, pixels: 16, animated: false, animationEvidence: 'png-no-actl', unsupported: false, reason: null, posterOnly: false } },
      poster: async (o) => { seen.push(o.absPath); await fs.writeFile(o.tmpPath, 'p'); return { file: 'poster.webp', mime: 'image/webp', width: 4, height: 4, bytes: 1, engine: 'sharp' } },
      motion: async () => { throw new Error('never') },
    },
  })
  await service.init()
  const good = { id: '1', name: 'x.png', kind: 'file', vault: false, sha256: 'd'.repeat(64), path: 'uploads/x.bin', ownerId: '2' }
  await service.info(good); await service.drain()
  assert.deepEqual(seen, [path.resolve(storageRoot, 'uploads', 'x.bin'), path.resolve(storageRoot, 'uploads', 'x.bin')])
  const bad = await service.info({ ...good, id: '2', sha256: 'e'.repeat(64), path: '../../etc/passwd' })
  assert.deepEqual([bad.status, bad.reason], ['UNSUPPORTED', 'SOURCE_MISSING'])
  assert.equal(seen.length, 2)
  await service.stop()
})
