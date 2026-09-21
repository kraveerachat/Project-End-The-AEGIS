// tests/vaultThumbScheduler.test.js — AEGIS Drive (IDEA1) · PR #157 Task 7.1 · bounded thumbnail scheduler (TS-LIMIT-*, TSC-*)
//
//   TS-LIMIT-JOBS  งาน decode พร้อมกันไม่เกิน limits.maxConcurrentJobs; ที่เหลือเข้าคิว; scroll-out ยกเลิก
//                  ทั้งคิวและงานที่กำลังวิ่ง (AbortSignal)
//   TS-LIMIT-URLS  Object URL ที่เก็บไม่เกิน limits.maxRetainedObjectUrls; LRU revoke ตัวเก่าสุด (spy)
//   TS-LIMIT-MEM   หน่วยความจำประมาณการ (พิกเซล + input ของงานมีชีวิต) ไม่เกิน limits.memoryCeilingBytes;
//                  รายการที่เกินงบรอ (ไม่เริ่ม)
//   TSC-1  document.hidden → งานที่กำลังวิ่งถูก abort, คิวหยุด; กลับมามองเห็น = ทำต่อ
//   TSC-2  releaseAll (purge) → revoke ทุก URL + abort ทุกงาน; stats() กลับเป็นศูนย์
//   TSC-3  integrity failure ใน decode → รายการถูก mark failed, retry ได้ครั้งเดียว, ไม่มี URL เกิด
//   TSC-4  เปลี่ยนโฟลเดอร์/นำทาง → รายการนอกโฟลเดอร์ปัจจุบันถูก release
import test from 'node:test'
import assert from 'node:assert/strict'

import { VAULT_TREE_CLIENT_LIMITS, treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { createThumbScheduler } from '../src/lib/vaultThumbScheduler.js'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'

const limits = treeLimitsFrom({ maxConcurrentJobs: 2, maxRetainedObjectUrls: 4, memoryCeilingBytes: 4096 })

/** ควบคุมจังหวะ decode ด้วยประตูของเทสต์เอง (ไม่มีการหน่วงเวลา) */
function deferred() {
  let release
  const promise = new Promise((r) => { release = r })
  return { promise, release }
}

function makeLoad(calls) {
  return async (key, { signal } = {}) => {
    calls.push({ key, aborted: signal?.aborted ?? false })
    const d = deferred()
    signal?.addEventListener('abort', () => d.release(), { once: true })
    await d.promise
    if (signal?.aborted) throw new Error('aborted')
    // 8×8 px → 256 bytes pixel estimate + 100 bytes input ≈ 356 bytes/job
    return { key, width: 8, height: 8, bytes: new Uint8Array(100), mime: 'image/png' }
  }
}

test('TS-LIMIT-JOBS concurrency bound, queueing, and scroll-out cancellation', async () => {
  const calls = []
  const revoked = []
  const sched = createThumbScheduler({
    limits,
    load: makeLoad(calls),
    revokeObjectUrl: (u) => revoked.push(u),
  })
  // 5 entries with a concurrency of 2 → 2 running, 3 queued
  for (let i = 0; i < 5; i += 1) sched.observe(`k${i}`)
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  const st = sched.stats()
  assert.equal(st.running, 2, 'at most maxConcurrentJobs run at once')
  assert.equal(st.queued, 3, 'the rest queue')
  // release the two running jobs → next two from the queue start
  sched.resolveForTest('k0', { width: 8, height: 8, urlBytes: new Uint8Array(1) })
  sched.resolveForTest('k1', { width: 8, height: 8, urlBytes: new Uint8Array(1) })
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  const st2 = sched.stats()
  assert.ok(st2.running + st2.queued >= 3, 'queued work continues after completion')
  // scroll-out: cancelling a queued key frees it; cancelling a running key aborts it
  sched.cancel('k2')
  sched.cancel('k3')
  sched.cancel('k4')
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  const st3 = sched.stats()
  assert.equal(st3.queued, 0, 'scroll-out empties the queue')
  await sched.releaseAll()
  assert.equal(sched.stats().running, 0, 'releaseAll aborts running jobs')
})

test('TS-LIMIT-URLS retained Object URLs are LRU-bounded and revoked on eviction', async () => {
  const revoked = []
  const created = []
  const sched = createThumbScheduler({
    limits: treeLimitsFrom({ maxRetainedObjectUrls: 3, maxConcurrentJobs: 4 }),
    load: async (key) => ({ key, width: 4, height: 4, bytes: new Uint8Array(10), mime: 'image/png' }),
    createObjectUrl: (blob) => { const u = `blob:mock/${created.length}`; created.push(u); return u },
    revokeObjectUrl: (u) => revoked.push(u),
  })
  for (let i = 0; i < 5; i += 1) sched.observe(`k${i}`)
  for (let i = 0; i < 5; i += 1) sched.resolveForTest(`k${i}`, { width: 4, height: 4, urlBytes: new Uint8Array(1) })
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  const st = sched.stats()
  assert.equal(st.urlsRetained, 3, 'retained URLs never exceed the bound')
  assert.equal(revoked.length, 2, 'the two oldest URLs were LRU-revoked')
  assert.ok(revoked.includes('blob:mock/0') && revoked.includes('blob:mock/1'), 'the oldest URLs were revoked first')
  await sched.releaseAll()
  assert.equal(sched.stats().urlsRetained, 0, 'releaseAll revokes everything')
  assert.equal(revoked.length, 5, 'every created URL was revoked exactly once')
})

test('TS-LIMIT-MEM the estimated memory ceiling gates new jobs; over-budget entries wait', async () => {
  const calls = []
  const sched = createThumbScheduler({
    limits: treeLimitsFrom({ maxConcurrentJobs: 8, memoryCeilingBytes: 1000 }),
    load: makeLoad(calls),
  })
  // each entry reserves 300 estimated bytes → three fit under 1000, the fourth waits;
  // after decode the reservation is replaced by the real (bytes + decoded pixels) figure
  for (let i = 0; i < 4; i += 1) sched.observe(`m${i}`, { estimateBytes: 300 })
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  const st = sched.stats()
  assert.equal(st.running, 3, 'three jobs fit under the ceiling')
  assert.equal(st.queued, 1, 'the fourth waits (over-budget)')
  assert.ok(st.estMemBytes <= 1000, `estimated memory stays under the ceiling (${st.estMemBytes})`)
  await sched.releaseAll()
})

test('TSC-1 visibility loss pauses everything; visible resumes', async () => {
  let hidden = false
  let visCb = null
  const calls = []
  const sched = createThumbScheduler({
    limits,
    load: makeLoad(calls),
    visibility: () => hidden,
    onVisibilityChange: (fn) => { visCb = fn },
  })
  for (let i = 0; i < 4; i += 1) sched.observe(`v${i}`)
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  assert.equal(sched.stats().running, 2, 'two running before the visibility loss')
  hidden = true
  visCb?.()
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  assert.equal(sched.stats().running, 0, 'running jobs abort when the page hides')
  assert.equal(sched.stats().queued, 4, 'the queue waits while hidden')
  hidden = false
  visCb?.()
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  assert.equal(sched.stats().running, 2, 'work resumes when the page is visible again')
  await sched.releaseAll()
})

test('TSC-2 releaseAll on purge aborts every job and revokes every URL; stats() zeroes', async () => {
  const revoked = []
  const calls = []
  const sched = createThumbScheduler({
    limits: treeLimitsFrom({ maxConcurrentJobs: 2, maxRetainedObjectUrls: 8 }),
    load: makeLoad(calls),
    revokeObjectUrl: (u) => revoked.push(u),
  })
  for (let i = 0; i < 6; i += 1) sched.observe(`p${i}`)
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
  sched.resolveForTest('p0', { width: 4, height: 4, urlBytes: new Uint8Array(1) })
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  await sched.releaseAll()
  const st = sched.stats()
  assert.equal(st.running, 0, 'releaseAll aborts running jobs')
  assert.equal(st.queued, 0, 'releaseAll empties the queue')
  assert.equal(st.urlsRetained, 0, 'every URL revoked')
  assert.equal(st.estMemBytes, 0, 'memory estimate resets')
})

test('TSC-3 an integrity failure marks the entry failed with one retry and no URL', async () => {
  let attempts = 0
  const created = []
  const sched = createThumbScheduler({
    limits,
    load: async () => {
      attempts += 1
      throw new Error('INTEGRITY')
    },
    createObjectUrl: (blob) => { const u = `blob:mock/${created.length}`; created.push(u); return u },
  })
  sched.observe('bad')
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  const st = sched.stats()
  assert.equal(attempts, 2, 'exactly one retry after the integrity failure')
  assert.equal(st.failures, 1, 'the entry is marked failed')
  assert.equal(created.length, 0, 'no URL is created for a failed decode')
  await sched.releaseAll()
})

test('TSC-4 navigation releases entries outside the current folder', async () => {
  const revoked = []
  const sched = createThumbScheduler({
    limits: treeLimitsFrom({ maxConcurrentJobs: 4, maxRetainedObjectUrls: 16 }),
    load: async (key) => ({ key, width: 4, height: 4, bytes: new Uint8Array(10), mime: 'image/png' }),
    revokeObjectUrl: (u) => revoked.push(u),
  })
  sched.observe('a', { folderId: 'F1' })
  sched.observe('b', { folderId: 'F1' })
  sched.observe('c', { folderId: 'F2' })
  for (const k of ['a', 'b', 'c']) sched.resolveForTest(k, { width: 4, height: 4, urlBytes: new Uint8Array(1) })
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  sched.releaseFolder('F1')
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  const st = sched.stats()
  assert.equal(st.urlsRetained, 1, 'only the F2 entry survives the folder release')
  await sched.releaseAll()
  assert.equal(revoked.length, 3, 'every URL revoked exactly once overall')
})
