// tests/mediaQueue.test.js — AEGIS Drive (IDEA1) · bounded, de-duplicated, prioritised media job queue (Task 3)
//
// ⚠️ ตรึงสัญญาของคิว (spec §13): key เดียวกันวิ่งครั้งเดียว, P0 มาก่อน P2, promote ได้เฉพาะงานที่รอ,
//    จำนวน worker ตายตัว, ความลึกมีเพดาน (ล้น = ปฏิเสธ ไม่ใช่รอ), งานที่พังไม่หยุดคิว, shutdown
//    ยกเลิกงานที่วิ่งอยู่ผ่าน AbortSignal และปฏิเสธงานที่รอ — ไม่มี child process จริงในชุดนี้
import test from 'node:test'
import assert from 'node:assert/strict'

import { createJobQueue, PRIORITY, QueueFullError, QueueShutdownError } from '../server/media/queue.js'

/** งานที่ควบคุมการจบได้จากภายนอก */
function controllable(value) {
  let resolve, reject
  const done = new Promise((res, rej) => { resolve = res; reject = rej })
  const calls = []
  const run = ({ signal }) => { calls.push(signal); return done }
  return { run, calls, resolve: () => resolve(value), reject: (e) => reject(e), done }
}
const tick = () => new Promise((r) => setImmediate(r))

test('JQ-1 dedup: the same key enqueued twice runs once and both callers get the same result', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const job = controllable('poster-ready')
  const first = q.enqueue('v1/a/poster', PRIORITY.INTERACTIVE, job.run)
  const second = q.enqueue('v1/a/poster', PRIORITY.WARMUP, job.run)
  assert.equal(first.deduplicated, false)
  assert.equal(second.deduplicated, true)
  await tick()
  assert.equal(job.calls.length, 1)
  job.resolve()
  assert.equal(await first.promise, 'poster-ready')
  assert.equal(await second.promise, 'poster-ready')
  assert.equal(q.size(), 0)
})

test('JQ-2 priority order: a P0 arriving behind three P2 jobs runs next after the current job', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const order = []
  const current = controllable()
  q.enqueue('current', PRIORITY.WARMUP, current.run)
  const mk = (key) => ({ signal }) => { order.push(key); return Promise.resolve(key) }
  q.enqueue('w1', PRIORITY.WARMUP, mk('w1'))
  q.enqueue('w2', PRIORITY.WARMUP, mk('w2'))
  q.enqueue('w3', PRIORITY.WARMUP, mk('w3'))
  const p0 = q.enqueue('hot', PRIORITY.INTERACTIVE, mk('hot'))
  await tick()
  assert.deepEqual(order, [], 'nothing else runs while the current job is busy (concurrency 1)')
  current.resolve()
  await p0.promise
  assert.equal(order[0], 'hot')
  await Promise.all([q.enqueue('w3', PRIORITY.WARMUP, mk('x')).promise])
  assert.deepEqual(order, ['hot', 'w1', 'w2', 'w3'])
})

test('JQ-3 promote: a queued P2 key moved to P0 jumps ahead of other P2 jobs; promoting a running job is a no-op', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const order = []
  const current = controllable()
  q.enqueue('current', PRIORITY.WARMUP, current.run)
  const mk = (key) => () => { order.push(key); return Promise.resolve(key) }
  q.enqueue('w1', PRIORITY.WARMUP, mk('w1'))
  q.enqueue('w2', PRIORITY.WARMUP, mk('w2'))
  const late = q.enqueue('w3', PRIORITY.WARMUP, mk('w3'))
  assert.equal(q.promote('w3', PRIORITY.INTERACTIVE), true)
  assert.equal(q.promote('current', PRIORITY.INTERACTIVE), false, 'running job: no-op')
  assert.equal(q.promote('missing', PRIORITY.INTERACTIVE), false)
  assert.equal(q.stats().byPriority[PRIORITY.INTERACTIVE], 1)
  current.resolve()
  await late.promise
  assert.equal(order[0], 'w3')
  // demotion is not promotion: lowering priority is ignored
  const w1 = q.enqueue('w1', PRIORITY.WARMUP, mk('w1'))
  assert.equal(q.promote('w1', PRIORITY.WARMUP), false)
  await w1.promise
})

test('JQ-4 fixed concurrency: 1 never overlaps; 2 allows two in flight', async () => {
  for (const [concurrency, expectedMax] of [[1, 1], [2, 2]]) {
    const q = createJobQueue({ concurrency, maxDepth: 10 })
    let inFlight = 0
    let maxSeen = 0
    const mk = (key) => async () => {
      inFlight += 1; maxSeen = Math.max(maxSeen, inFlight, q.running())
      await new Promise((r) => setTimeout(r, 15))
      inFlight -= 1
      return key
    }
    const jobs = ['a', 'b', 'c', 'd'].map((k) => q.enqueue(k, PRIORITY.UPLOAD, mk(k)).promise)
    await Promise.all(jobs)
    assert.equal(maxSeen, expectedMax, `concurrency ${concurrency}`)
  }
})

test('JQ-5 maxDepth: the fourth distinct enqueue is refused with QueueFullError; size() stays 3', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 3 })
  const current = controllable()
  q.enqueue('a', PRIORITY.UPLOAD, current.run)
  q.enqueue('b', PRIORITY.UPLOAD, () => Promise.resolve('b'))
  q.enqueue('c', PRIORITY.UPLOAD, () => Promise.resolve('c'))
  assert.equal(q.size(), 3)
  const fourth = q.enqueue('d', PRIORITY.UPLOAD, () => Promise.resolve('d'))
  assert.equal(fourth.deduplicated, false)
  await assert.rejects(fourth.promise, QueueFullError)
  assert.equal(q.size(), 3)
  assert.equal(q.has('d'), false)
  // a duplicate of an existing key is never a depth violation
  const dup = q.enqueue('b', PRIORITY.INTERACTIVE, () => Promise.resolve('never'))
  assert.equal(dup.deduplicated, true)
  current.resolve()
  await Promise.all([dup.promise])
})

test('JQ-6 failure isolation: a rejecting job does not stop the queue; stats().failed increments', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const bad = q.enqueue('bad', PRIORITY.UPLOAD, () => Promise.reject(new Error('encoder exploded')))
  const good = q.enqueue('good', PRIORITY.UPLOAD, () => Promise.resolve('fine'))
  await assert.rejects(bad.promise, /encoder exploded/)
  assert.equal(await good.promise, 'fine')
  assert.equal(q.stats().failed, 1)
  assert.equal(q.stats().completed, 1)
  assert.equal(q.running(), 0)
})

test('JQ-7 shutdown: the running job is aborted, queued jobs reject with QueueShutdownError, later enqueues are refused', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const running = controllable('late')
  const r = q.enqueue('running', PRIORITY.INTERACTIVE, running.run)
  const queued = q.enqueue('queued', PRIORITY.INTERACTIVE, () => Promise.resolve('never'))
  await tick()
  assert.equal(running.calls[0].aborted, false)
  await q.shutdown({ reason: 'SIGTERM' })
  assert.equal(running.calls[0].aborted, true, 'running job received abort')
  assert.equal(running.calls[0].reason?.message ?? running.calls[0].reason, 'SIGTERM')
  await assert.rejects(queued.promise, QueueShutdownError)
  running.resolve() // the job may still settle after abort; the queue must not throw
  assert.equal(await r.promise, 'late')
  const after = q.enqueue('after', PRIORITY.INTERACTIVE, () => Promise.resolve('x'))
  await assert.rejects(after.promise, QueueShutdownError)
})

test('JQ-8 stats(): depth, running, byPriority, completed, failed', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const current = controllable()
  q.enqueue('run', PRIORITY.UPLOAD, current.run)
  q.enqueue('p0', PRIORITY.INTERACTIVE, () => Promise.resolve())
  q.enqueue('p2a', PRIORITY.WARMUP, () => Promise.resolve())
  q.enqueue('p2b', PRIORITY.WARMUP, () => Promise.resolve())
  await tick()
  assert.deepEqual(q.stats(), { depth: 3, running: 1, byPriority: { 0: 1, 1: 0, 2: 2 }, completed: 0, failed: 0 })
  current.resolve()
  await tick(); await tick(); await tick(); await tick()
  assert.deepEqual(q.stats(), { depth: 0, running: 0, byPriority: { 0: 0, 1: 0, 2: 0 }, completed: 4, failed: 0 })
})

test('JQ-9 has(key): true while queued or running, false after completion', async () => {
  const q = createJobQueue({ concurrency: 1, maxDepth: 10 })
  const current = controllable()
  q.enqueue('run', PRIORITY.UPLOAD, current.run)
  const waiting = q.enqueue('wait', PRIORITY.UPLOAD, () => Promise.resolve())
  await tick()
  assert.equal(q.has('run'), true)
  assert.equal(q.has('wait'), true)
  assert.equal(q.has('nope'), false)
  current.resolve()
  await waiting.promise
  await tick()
  assert.equal(q.has('run'), false)
  assert.equal(q.has('wait'), false)
})
