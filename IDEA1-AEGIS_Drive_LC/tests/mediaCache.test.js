// tests/mediaCache.test.js — AEGIS Drive (IDEA1) · content-addressed media cache core (Task 2)
//
// ⚠️ ตรึงตัวตนของ derivative: sha256 ของต้นฉบับ + profile + ชนิด — ชื่อไฟล์ไม่มีทางเข้ามาใน path
//    (API ไม่มีพารามิเตอร์ชื่อเลย), path traversal เป็นไปไม่ได้, cache อยู่นอก STORAGE_ROOT เสมอ,
//    ทุกการเขียนเป็น tmp + rename, และ "ไม่มี" = สถานะที่สร้างใหม่ได้ ไม่ใช่ error (spec §11–§12)
//    ไม่มี DB ไม่มี FFmpeg ไม่มี Sharp
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createMediaCache } from '../server/media/cache.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = '0123456789abcdef'.repeat(4)
let base, storageRoot, root, cache

before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-cache-'))
  storageRoot = path.join(base, 'datalake')
  root = path.join(base, 'cache')
  await fs.mkdir(storageRoot, { recursive: true })
  cache = createMediaCache({ root, profile: 'v1', storageRoot })
})
after(async () => { await fs.rm(base, { recursive: true, force: true }) })

const stateFor = (sha, overrides = {}) => ({
  profile: 'v1',
  sha256: sha,
  poster: { state: 'READY', file: 'poster.webp', mime: 'image/webp', width: 640, height: 360, bytes: 1, attempts: 1, generatedAt: '2026-09-18T00:00:00.000Z' },
  motion: { state: 'PENDING', attempts: 0, nextRetryAt: null, reason: null },
  lastAccess: '2026-09-18T00:00:00.000Z',
  ...overrides,
})

test('CC-1 isValidSha256: exactly 64 lowercase hex', () => {
  assert.equal(cache.isValidSha256(SHA_A), true)
  assert.equal(cache.isValidSha256(SHA_C), true)
  assert.equal(cache.isValidSha256('A'.repeat(64)), false)
  assert.equal(cache.isValidSha256('a'.repeat(63)), false)
  assert.equal(cache.isValidSha256('a'.repeat(65)), false)
  assert.equal(cache.isValidSha256('../' + 'a'.repeat(61)), false)
  assert.equal(cache.isValidSha256(''), false)
  assert.equal(cache.isValidSha256(null), false)
})

test('CC-2 layout: <root>/v1/<ab>/<cd>/<sha>; derivative names fixed; no filename parameter exists', () => {
  const dir = cache.entryDir(SHA_C)
  assert.equal(dir, path.join(root, 'v1', '01', '23', SHA_C))
  const p = cache.paths(SHA_C)
  assert.equal(p.dir, dir)
  assert.ok(p.poster('webp').endsWith(path.join(SHA_C, 'poster.webp')))
  assert.ok(p.poster('png').endsWith('poster.png'))
  assert.ok(p.motion.endsWith(path.join(SHA_C, 'motion.mp4')))
  assert.ok(p.probe.endsWith('probe.json'))
  assert.ok(p.state.endsWith('state.json'))
  assert.equal(p.tmpDir, path.join(root, 'tmp'))
  // the API takes no name: a hostile row name cannot influence any path
  const hostileRowName = 'evil/../../x.png'
  assert.equal(cache.entryDir.length, 1)
  assert.equal(cache.paths.length, 1)
  assert.ok(!JSON.stringify(p).includes(hostileRowName))
})

test('CC-3 traversal impossible: invalid sha throws; every entry dir resolves under root', () => {
  for (const bad of ['../../etc', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(60)}/../x`, '']) {
    assert.throws(() => cache.entryDir(bad), /sha256/)
    assert.throws(() => cache.paths(bad), /sha256/)
  }
  for (const sha of [SHA_A, SHA_B, SHA_C]) {
    assert.ok(path.resolve(cache.entryDir(sha)).startsWith(path.resolve(root) + path.sep))
  }
})

test('CC-4 constructor refuses a root inside storageRoot and a malformed profile', () => {
  assert.throws(() => createMediaCache({ root: path.join(storageRoot, 'cache'), profile: 'v1', storageRoot }), /STORAGE_ROOT|storage/i)
  assert.throws(() => createMediaCache({ root: storageRoot, profile: 'v1', storageRoot }), /STORAGE_ROOT|storage/i)
  assert.throws(() => createMediaCache({ root, profile: 'x1', storageRoot }), /profile/)
  assert.throws(() => createMediaCache({ root, profile: 'v', storageRoot }), /profile/)
  assert.doesNotThrow(() => createMediaCache({ root, profile: 'v2', storageRoot }))
})

test('CC-5 writeAtomic: tmp under <root>/tmp; final appears only after the producer resolves; failure leaves nothing', async () => {
  const p = cache.paths(SHA_A)
  let seenTmp = null
  await cache.writeAtomic(p.poster('webp'), async (tmpPath) => {
    seenTmp = tmpPath
    assert.ok(path.resolve(tmpPath).startsWith(path.resolve(p.tmpDir) + path.sep), 'tmp lives under <root>/tmp')
    assert.ok(/\.tmp-[0-9a-f-]+$/.test(tmpPath), 'tmp name carries a unique suffix')
    await fs.writeFile(tmpPath, 'poster-bytes')
    await assert.rejects(fs.access(p.poster('webp')), { code: 'ENOENT' }, 'final path absent while producing')
  })
  assert.equal(await fs.readFile(p.poster('webp'), 'utf8'), 'poster-bytes')
  await assert.rejects(fs.access(seenTmp), { code: 'ENOENT' }, 'tmp removed after rename')

  const failTarget = cache.paths(SHA_B).poster('webp')
  let failTmp = null
  await assert.rejects(cache.writeAtomic(failTarget, async (tmpPath) => {
    failTmp = tmpPath
    await fs.writeFile(tmpPath, 'partial')
    throw new Error('encoder exploded')
  }), /encoder exploded/)
  await assert.rejects(fs.access(failTarget), { code: 'ENOENT' })
  await assert.rejects(fs.access(failTmp), { code: 'ENOENT' }, 'no tmp file remains after failure')
})

test('CC-6 writeAtomic concurrent: last rename wins and a reader never observes a partial file', async () => {
  const target = cache.paths(SHA_C).poster('webp')
  const payloadA = 'A'.repeat(200_000)
  const payloadB = 'B'.repeat(300_000)
  const observed = new Set()
  let reading = true
  const reader = (async () => {
    while (reading) {
      try {
        const buf = await fs.readFile(target)
        observed.add(buf.length)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
        observed.add(0)
      }
      await new Promise((r) => setImmediate(r))
    }
  })()
  try {
    await Promise.all([
      cache.writeAtomic(target, (tmp) => fs.writeFile(tmp, payloadA)),
      cache.writeAtomic(target, (tmp) => fs.writeFile(tmp, payloadB)),
    ])
  } finally {
    reading = false
    await reader
  }
  for (const len of observed) assert.ok([0, payloadA.length, payloadB.length].includes(len), `partial length observed: ${len}`)
  const finalLen = (await fs.stat(target)).size
  assert.ok([payloadA.length, payloadB.length].includes(finalLen))
})

test('CC-7 state round-trip; missing entry reads as null, never throws', async () => {
  assert.equal(await cache.readState(SHA_B), null)
  assert.equal(await cache.readProbe(SHA_B), null)
  const state = stateFor(SHA_A)
  await cache.writeState(SHA_A, state)
  assert.deepEqual(await cache.readState(SHA_A), state)
  const probe = { probeVersion: 1, family: 'gif', width: 800, height: 450, animated: true, animationEvidence: 'gif-second-packet' }
  await cache.writeProbe(SHA_A, probe)
  assert.deepEqual(await cache.readProbe(SHA_A), probe)
  // corrupt JSON is "not there" for the reader (rebuildable), not a crash
  await fs.writeFile(cache.paths(SHA_B).state, '{not json')
  assert.equal(await cache.readState(SHA_B), null)
})

test('CC-8 identity: same sha → same dir (rename); different sha → different dir (replace); profile v2 → different dir', () => {
  assert.equal(cache.entryDir(SHA_A), cache.entryDir(SHA_A))
  assert.notEqual(cache.entryDir(SHA_A), cache.entryDir(SHA_B))
  const v2 = createMediaCache({ root, profile: 'v2', storageRoot })
  assert.notEqual(v2.entryDir(SHA_A), cache.entryDir(SHA_A))
  assert.ok(v2.entryDir(SHA_A).includes(`${path.sep}v2${path.sep}`))
  assert.ok(cache.entryDir(SHA_A).includes(`${path.sep}v1${path.sep}`))
})

test('CC-9 statDerivative: {path, bytes, mime} when present (mime from state.json), null when missing', async () => {
  assert.equal(await cache.statDerivative(SHA_B, 'poster'), null)
  await cache.writeState(SHA_A, stateFor(SHA_A))
  const webp = await cache.statDerivative(SHA_A, 'poster')
  assert.equal(webp.path, cache.paths(SHA_A).poster('webp'))
  assert.equal(webp.bytes, Buffer.byteLength('poster-bytes'))
  assert.equal(webp.mime, 'image/webp')
  assert.equal(await cache.statDerivative(SHA_A, 'motion'), null)
  // PNG fallback recorded in state.json → stat follows the recorded file name/mime
  await cache.writeAtomic(cache.paths(SHA_B).poster('png'), (tmp) => fs.writeFile(tmp, 'png!'))
  await cache.writeState(SHA_B, stateFor(SHA_B, { poster: { ...stateFor(SHA_B).poster, file: 'poster.png', mime: 'image/png', bytes: 4 } }))
  const png = await cache.statDerivative(SHA_B, 'poster')
  assert.equal(png.mime, 'image/png')
  assert.ok(png.path.endsWith('poster.png'))
  assert.equal(png.bytes, 4)
})

test('CC-10 touch: immediate in-memory lastAccess; persisted at most once per hour', async () => {
  let now = Date.parse('2026-09-18T10:00:00.000Z')
  const clocked = createMediaCache({ root, profile: 'v1', storageRoot, now: () => now })
  await clocked.writeState(SHA_A, stateFor(SHA_A))
  const before = (await fs.stat(clocked.paths(SHA_A).state)).mtimeMs
  await new Promise((r) => setTimeout(r, 20))
  await clocked.touch(SHA_A, now)
  now += 1000
  await clocked.touch(SHA_A, now)
  assert.equal(clocked.lastAccessOf(SHA_A), now, 'memory updated immediately')
  const persisted1 = await clocked.readState(SHA_A)
  assert.equal(persisted1.lastAccess, new Date(now - 1000).toISOString(), 'first touch persisted, second coalesced')
  const writesAfterFirst = (await fs.stat(clocked.paths(SHA_A).state)).mtimeMs
  assert.ok(writesAfterFirst >= before)
  now += 3_601_000
  await clocked.touch(SHA_A, now)
  assert.equal((await clocked.readState(SHA_A)).lastAccess, new Date(now).toISOString(), 'after an hour it persists again')
})

test('CC-11 cleanupTmp removes stale *.tmp-* only', async () => {
  const tmpDir = cache.paths(SHA_A).tmpDir
  await fs.mkdir(tmpDir, { recursive: true })
  const stale = path.join(tmpDir, 'job1.poster.tmp-aaaa')
  const fresh = path.join(tmpDir, 'job2.motion.tmp-bbbb')
  const other = path.join(tmpDir, 'README')
  await fs.writeFile(stale, 'x'); await fs.writeFile(fresh, 'y'); await fs.writeFile(other, 'z')
  const old = new Date(Date.now() - 600_000)
  await fs.utimes(stale, old, old)
  const result = await cache.cleanupTmp({ olderThanMs: 120_000 })
  assert.equal(result.removed, 1)
  await assert.rejects(fs.access(stale), { code: 'ENOENT' })
  await fs.access(fresh)
  await fs.access(other)
})

test('CC-12 scanEntries yields every entry across profiles; staleProfileDirs lists non-current profiles', async () => {
  const v0 = createMediaCache({ root, profile: 'v0', storageRoot })
  await v0.writeAtomic(v0.paths(SHA_A).poster('webp'), (tmp) => fs.writeFile(tmp, 'old-poster'))
  await v0.writeState(SHA_A, stateFor(SHA_A, { profile: 'v0' }))
  const entries = []
  for await (const e of cache.scanEntries()) entries.push(e)
  const a1 = entries.find((e) => e.sha === SHA_A && e.profile === 'v1')
  const a0 = entries.find((e) => e.sha === SHA_A && e.profile === 'v0')
  assert.ok(a1 && a0, 'both profiles scanned')
  assert.equal(a1.bytes, Buffer.byteLength('poster-bytes'), 'bytes = sum of derivative files (json excluded)')
  assert.equal(a0.bytes, Buffer.byteLength('old-poster'))
  assert.equal(a1.lastAccess, (await cache.readState(SHA_A)).lastAccess, 'lastAccess mirrors the persisted state (CC-10 touched this entry)')
  assert.ok(entries.some((e) => e.sha === SHA_B && e.profile === 'v1'))
  assert.deepEqual(await cache.staleProfileDirs(), ['v0'])
})

test('CC-13 removeEntry: rename into tmp/evict-* then unlink; concurrent readState is null or complete', async () => {
  await cache.writeState(SHA_C, stateFor(SHA_C))
  await cache.writeAtomic(cache.paths(SHA_C).motion, (tmp) => fs.writeFile(tmp, 'mp4'))
  const dir = cache.entryDir(SHA_C)
  const results = []
  let reading = true
  const reader = (async () => {
    while (reading) {
      const s = await cache.readState(SHA_C)
      results.push(s === null ? null : s.sha256)
      await new Promise((r) => setImmediate(r))
    }
  })()
  let removed
  try {
    removed = await cache.removeEntry(SHA_C)
  } finally {
    reading = false
    await reader
  }
  assert.equal(removed, true)
  await assert.rejects(fs.access(dir), { code: 'ENOENT' })
  for (const r of results) assert.ok(r === null || r === SHA_C)
  const leftovers = (await fs.readdir(cache.paths(SHA_C).tmpDir)).filter((n) => n.startsWith('evict-'))
  assert.deepEqual(leftovers, [], 'evicted directory fully unlinked')
  assert.equal(await cache.removeEntry(SHA_C), false, 'second removal reports nothing to remove')
})
