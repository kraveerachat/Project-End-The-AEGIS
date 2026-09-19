// tests/mediaEviction.test.js — AEGIS Drive (IDEA1) · LRU eviction of the rebuildable media cache (Task 7)
//
// ⚠️ spec §19: งบไบต์ high-water → ลบ entry ที่เข้าถึงเก่าสุดจน ≤ low-water; profile เก่าก่อนเสมอ;
//    entry ที่มีงานค้าง/เพิ่งถูกเสิร์ฟ (< 60 s) ถูก pin; ลบทั้ง entry; ความล้มเหลวของการลบไม่หยุดรอบ
import test from 'node:test'
import assert from 'node:assert/strict'

import { createEvictor, PIN_RECENT_MS } from '../server/media/eviction.js'
import { mediaLimitsFromEnv } from '../server/config/mediaLimits.js'

const MIB = 1_048_576
const SHA = (n) => n.toString(16).padStart(64, '0')
function fakeCache({ profile = 'v1', entries = [], stale = [] } = {}) {
  const removed = []
  const failing = new Set()
  return {
    profile, removed, failing,
    async * scanEntries() { for (const e of entries) yield { ...e } },
    async staleProfileDirs() { return stale },
    async removeEntry(sha) { if (failing.has(sha)) { const err = new Error('EBUSY'); err.code = 'EBUSY'; throw err } removed.push(`${profile}/${sha}`); return true },
  }
}
const limitsOf = (max) => mediaLimitsFromEnv({ MEDIA_CACHE_MAX_BYTES: String(max) })
const at = (iso) => Date.parse(iso)

test('EV-1 buildIndex sums bytes across entries and keeps lastAccess', async () => {
  const cache = fakeCache({ entries: [
    { sha: SHA(1), profile: 'v1', bytes: 10 * MIB, lastAccess: '2026-09-18T10:00:00.000Z' },
    { sha: SHA(2), profile: 'v1', bytes: 5 * MIB, lastAccess: null },
  ] })
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(64 * MIB), now: () => at('2026-09-18T12:00:00.000Z') })
  await ev.buildIndex()
  assert.equal(ev.totalBytes(), 15 * MIB)
  const e = ev.entries()
  assert.equal(e.length, 2)
  assert.equal(e.find((x) => x.sha === SHA(1)).lastAccess, at('2026-09-18T10:00:00.000Z'))
  assert.equal(e.find((x) => x.sha === SHA(2)).lastAccess, 0, 'unknown access sorts as oldest')
})

test('EV-2 below high water nothing is evicted', async () => {
  const cache = fakeCache({ entries: [{ sha: SHA(1), profile: 'v1', bytes: 30 * MIB, lastAccess: '2026-09-18T10:00:00.000Z' }] })
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(64 * MIB), now: () => at('2026-09-18T12:00:00.000Z') })
  await ev.buildIndex()
  assert.deepEqual(await ev.runIfNeeded(), { evicted: 0, bytesFreed: 0 })
  assert.deepEqual(cache.removed, [])
})

test('EV-3 over high water → evict LRU-first down to low water (0.8 × max)', async () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({ sha: SHA(n), profile: 'v1', bytes: 20 * MIB, lastAccess: `2026-09-18T0${n}:00:00.000Z` }))
  const cache = fakeCache({ entries })
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(80 * MIB), now: () => at('2026-09-18T12:00:00.000Z') })
  await ev.buildIndex()
  assert.equal(ev.totalBytes(), 100 * MIB)
  const r = await ev.runIfNeeded()
  // target = 64 MiB → remove the two oldest (01:00, 02:00) → 60 MiB
  assert.deepEqual(cache.removed, [`v1/${SHA(1)}`, `v1/${SHA(2)}`])
  assert.deepEqual(r, { evicted: 2, bytesFreed: 40 * MIB })
  assert.equal(ev.totalBytes(), 60 * MIB)
})

test('EV-4 pinned entries (in-flight or served within 60 s) are skipped even when LRU', async () => {
  const entries = [1, 2, 3].map((n) => ({ sha: SHA(n), profile: 'v1', bytes: 40 * MIB, lastAccess: `2026-09-18T0${n}:00:00.000Z` }))
  const cache = fakeCache({ entries })
  const now = at('2026-09-18T12:00:00.000Z')
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(64 * MIB), isPinned: (sha) => sha === SHA(1), now: () => now })
  await ev.buildIndex()
  ev.touch(SHA(2), now - 10_000) // served 10 s ago → recent pin
  assert.equal(PIN_RECENT_MS, 60_000)
  await ev.runIfNeeded()
  assert.deepEqual(cache.removed, [`v1/${SHA(3)}`], 'only the unpinned entry goes; the pass ends even though still above target')
})

test('EV-5 stale profile directories are evicted first regardless of lastAccess', async () => {
  const v1 = fakeCache({ profile: 'v1', entries: [
    { sha: SHA(1), profile: 'v1', bytes: 30 * MIB, lastAccess: '2026-09-18T01:00:00.000Z' },
    { sha: SHA(9), profile: 'v0', bytes: 30 * MIB, lastAccess: '2026-09-18T11:00:00.000Z' },
  ], stale: ['v0'] })
  const v0 = fakeCache({ profile: 'v0' })
  const ev = createEvictor({ cache: v1, cacheForProfile: (p) => (p === 'v0' ? v0 : v1), limits: limitsOf(64 * MIB), now: () => at('2026-09-18T12:00:00.000Z') })
  await ev.buildIndex()
  ev.record(SHA(2), 20 * MIB, at('2026-09-18T11:30:00.000Z')) // 80 MiB total > 64
  await ev.runIfNeeded()
  assert.deepEqual(v0.removed, [`v0/${SHA(9)}`], 'newest-but-stale profile entry goes first')
  assert.deepEqual(v1.removed, [], 'current profile untouched once under target (50 MiB ≤ 51.2)')
})

test('EV-6 record()/touch()/remove() keep the index consistent', async () => {
  const cache = fakeCache()
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(64 * MIB), now: () => 1000 })
  await ev.buildIndex()
  ev.record(SHA(1), 5 * MIB, 500)
  ev.record(SHA(1), 7 * MIB, 600) // re-record replaces bytes, keeps latest access
  assert.equal(ev.totalBytes(), 7 * MIB)
  ev.touch(SHA(1), 900)
  assert.equal(ev.entries()[0].lastAccess, 900)
  ev.touch(SHA(2), 950) // unknown sha → ignored
  assert.equal(ev.entries().length, 1)
  ev.remove(SHA(1))
  assert.equal(ev.totalBytes(), 0)
})

test('EV-7 schedule() runs the pass on an interval and stop() clears it', async () => {
  const cache = fakeCache({ entries: [1, 2].map((n) => ({ sha: SHA(n), profile: 'v1', bytes: 40 * MIB, lastAccess: `2026-09-18T0${n}:00:00.000Z` })) })
  const timers = []
  const setIntervalFake = (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h }
  const clearIntervalFake = (h) => { h.cleared = true }
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(64 * MIB), now: () => at('2026-09-18T12:00:00.000Z'), setIntervalFn: setIntervalFake, clearIntervalFn: clearIntervalFake })
  await ev.buildIndex()
  const stop = ev.schedule(600_000)
  assert.equal(timers[0].ms, 600_000)
  await timers[0].fn()
  assert.deepEqual(cache.removed, [`v1/${SHA(1)}`])
  stop()
  assert.equal(timers[0].cleared, true)
})

test('EV-8 a removal failure is logged and skipped; the pass continues with the next candidate', async () => {
  const cache = fakeCache({ entries: [1, 2, 3].map((n) => ({ sha: SHA(n), profile: 'v1', bytes: 40 * MIB, lastAccess: `2026-09-18T0${n}:00:00.000Z` })) })
  cache.failing.add(SHA(1))
  const logs = []
  const ev = createEvictor({ cache, cacheForProfile: () => cache, limits: limitsOf(64 * MIB), now: () => at('2026-09-18T12:00:00.000Z'), log: (...a) => logs.push(a.join(' ')) })
  await ev.buildIndex()
  const r = await ev.runIfNeeded()
  assert.deepEqual(cache.removed, [`v1/${SHA(2)}`, `v1/${SHA(3)}`])
  assert.equal(r.evicted, 2)
  assert.ok(logs.some((l) => l.includes('EBUSY')))
  assert.equal(ev.totalBytes(), 40 * MIB, 'the failed entry stays accounted')
})
