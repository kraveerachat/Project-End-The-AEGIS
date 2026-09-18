// tests/mediaScheduler.test.js — AEGIS Drive (IDEA1) · viewport media scheduler (Tranche B / B2, plan Task 12)
//
// แถบจาก IntersectionObserver สองตัว (visible / near) → เลน priority ต่อชนิดงาน (info / poster / motion) พร้อมเพดาน
// info batch 1, poster 6, motion 3; visible ก่อน near ก่อน off; hover เลื่อนขึ้นหน้าสุด (แย่ง slot motion ถ้าเต็ม);
// unregister/off ยกเลิกงานที่รอ; 2,000 ไทล์ไม่ทำให้เกิด 2,000 คำขอ; ไม่มี polling storm
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let vite, mod
before(async () => {
  vite = await createServer({ configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent', plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } })
  mod = await vite.ssrLoadModule('/src/lib/mediaScheduler.js')
})
after(async () => { await vite?.close() })

/** observer ปลอมสองตัว (visible / near) ที่เทสต์ขับเอง: enter(el, band) / leave(el) */
function fakeObservers() {
  const observers = []
  const createObserver = (callback, { rootMargin }) => {
    const ob = { rootMargin, callback, observed: new Set(), observe(el) { this.observed.add(el) }, unobserve(el) { this.observed.delete(el) }, disconnect() { this.observed.clear() } }
    observers.push(ob)
    return ob
  }
  const vis = () => observers.find((o) => o.rootMargin === '0px')
  const near = () => observers.find((o) => o.rootMargin !== '0px')
  const fire = (ob, el, isIntersecting) => { if (ob.observed.has(el)) ob.callback([{ target: el, isIntersecting }]) }
  return {
    createObserver, observers,
    enter(el, band) {
      if (band === 'visible') { fire(near(), el, true); fire(vis(), el, true) }
      else if (band === 'near') { fire(vis(), el, false); fire(near(), el, true) }
      else { fire(vis(), el, false); fire(near(), el, false) }
    },
    leave(el) { fire(vis(), el, false); fire(near(), el, false) },
  }
}
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)) }
const el = (i) => ({ id: `el${i}` })

/** สภาพแวดล้อมมาตรฐาน: บันทึกทุก callback; งาน poster/motion ค้างจนกว่าเทสต์จะปล่อย */
function harness({ autoPoster = false, autoMotion = false, infoPosterChain = true } = {}) {
  const obs = fakeObservers()
  const log = { info: [], poster: [], motion: [], aborted: [] }
  const pending = { poster: new Map(), motion: new Map() }
  let sched
  const onInfo = async (keys) => {
    log.info.push([...keys])
    const out = new Map()
    for (const k of keys) out.set(k, { id: k, status: 'READY' })
    if (infoPosterChain) for (const k of keys) sched.request(k, 'poster')
    return out
  }
  const work = (kind) => (key, { signal }) => {
    log[kind].push(key)
    if ((kind === 'poster' && autoPoster) || (kind === 'motion' && autoMotion)) return Promise.resolve()
    const d = deferred()
    pending[kind].set(key, d)
    signal.addEventListener('abort', () => { log.aborted.push(`${kind}:${key}`); pending[kind].delete(key); d.reject(new Error('aborted')) }, { once: true })
    return d.promise.finally(() => pending[kind].delete(key))
  }
  sched = mod.createMediaScheduler({ createObserver: obs.createObserver, onInfo, onPoster: work('poster'), onMotion: work('motion') })
  const release = (kind, key) => { const d = pending[kind].get(key); if (d) d.resolve() }
  return { obs, log, sched, release, pending }
}

test('VS-1 10 tiles, 4 visible → one onInfo batch with exactly those keys; posters follow; off-band tiles queue nothing', async () => {
  const h = harness({ autoPoster: true })
  const els = Array.from({ length: 10 }, (_, i) => el(i))
  els.forEach((e, i) => h.sched.register(`k${i}`, e, { animated: false }))
  for (let i = 0; i < 4; i += 1) h.obs.enter(els[i], 'visible')
  for (let i = 0; i < 10; i += 1) h.sched.request(`k${i}`, 'info')
  await flush()
  assert.deepEqual(h.log.info, [['k0', 'k1', 'k2', 'k3']])
  await flush()
  assert.deepEqual(h.log.poster.sort(), ['k0', 'k1', 'k2', 'k3'])
  const snap = h.sched.snapshot()
  assert.equal(snap.queued.info, 0, 'off-band info is parked, not queued')
  assert.equal(snap.parked.info, 6)
  assert.deepEqual(snap.inflight, { info: 0, poster: 0, motion: 0 })
})

test('VS-2 near band: info + poster after visible work; motion for near animated tiles only after visible motion', async () => {
  const h = harness({ autoPoster: true, autoMotion: true, infoPosterChain: false })
  const a = el(1), b = el(2)
  h.sched.register('vis', a, { animated: true }); h.sched.register('near', b, { animated: true })
  h.obs.enter(b, 'near'); h.obs.enter(a, 'visible')
  h.sched.request('near', 'info'); h.sched.request('vis', 'info')
  await flush()
  assert.deepEqual(h.log.info, [['vis', 'near']], 'visible keys precede near keys inside the one batch')
  h.sched.request('near', 'motion'); h.sched.request('vis', 'motion')
  await flush()
  assert.deepEqual(h.log.motion, ['vis', 'near'])
})

test('VS-3 caps: 20 visible tiles → inflight poster ≤ 6, motion ≤ 3, info ≤ 1 at every tick; a freed slot starts the next eligible item', async () => {
  const h = harness({ infoPosterChain: false })
  const els = Array.from({ length: 20 }, (_, i) => el(i))
  els.forEach((e, i) => { h.sched.register(`k${i}`, e, { animated: true }); h.obs.enter(e, 'visible') })
  for (let i = 0; i < 20; i += 1) { h.sched.request(`k${i}`, 'info'); h.sched.request(`k${i}`, 'poster'); h.sched.request(`k${i}`, 'motion') }
  await flush()
  let snap = h.sched.snapshot()
  assert.deepEqual(snap.inflight, { info: 0, poster: 6, motion: 3 }, 'info batch already settled (one batch of 20), poster/motion capped')
  assert.equal(h.log.info.length, 1); assert.equal(h.log.info[0].length, 20)
  assert.deepEqual(h.log.poster, ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'])
  assert.deepEqual(h.log.motion, ['k0', 'k1', 'k2'])
  h.release('poster', 'k0'); await flush()
  snap = h.sched.snapshot()
  assert.equal(snap.inflight.poster, 6); assert.equal(h.log.poster.at(-1), 'k6')
  h.release('motion', 'k1'); await flush()
  assert.equal(h.sched.snapshot().inflight.motion, 3); assert.equal(h.log.motion.at(-1), 'k3')
  assert.equal(h.sched.snapshot().queued.poster, 13); assert.equal(h.sched.snapshot().queued.motion, 16)
  assert.deepEqual(mod.MEDIA_SCHEDULER_CAPS, { info: 1, poster: 6, motion: 3 })
})

test('VS-4 hover promotion: a near tile with motion queued jumps to the front; with 3 in flight the lowest-priority prefetch is preempted (aborted) and re-queued', async () => {
  const h = harness({ infoPosterChain: false })
  const els = Array.from({ length: 6 }, (_, i) => el(i))
  els.forEach((e, i) => h.sched.register(`k${i}`, e, { animated: true }))
  for (let i = 0; i < 4; i += 1) h.obs.enter(els[i], 'visible')
  h.obs.enter(els[4], 'near'); h.obs.enter(els[5], 'near')
  for (let i = 0; i < 6; i += 1) h.sched.request(`k${i}`, 'motion')
  await flush()
  assert.deepEqual(h.log.motion, ['k0', 'k1', 'k2'])
  h.sched.hover('k5', true)
  await flush()
  assert.deepEqual(h.log.motion, ['k0', 'k1', 'k2', 'k5'], 'hovered near tile starts immediately')
  assert.deepEqual(h.log.aborted, ['motion:k2'], 'the most recently started non-hover prefetch was preempted')
  assert.equal(h.sched.snapshot().inflight.motion, 3)
  h.release('motion', 'k5'); await flush()
  assert.equal(h.log.motion.at(-1), 'k2', 'the preempted visible item is retried in its DOM position (VS-9 rule), ahead of k3')
  h.release('motion', 'k0'); await flush()
  assert.equal(h.log.motion.at(-1), 'k3', 'then the next visible item; near tiles still wait')
  assert.ok(!h.log.motion.includes('k4'), 'near tile k4 has not started while visible work remains')
})

test('VS-5 unregister removes queued work and aborts in-flight work for the key', async () => {
  const h = harness({ infoPosterChain: false })
  const els = Array.from({ length: 8 }, (_, i) => el(i))
  els.forEach((e, i) => { h.sched.register(`k${i}`, e, { animated: true }); h.obs.enter(e, 'visible') })
  for (let i = 0; i < 8; i += 1) { h.sched.request(`k${i}`, 'poster'); h.sched.request(`k${i}`, 'motion') }
  await flush()
  assert.equal(h.sched.snapshot().queued.poster, 2)
  h.sched.unregister('k0')
  h.sched.unregister('k7')
  await flush()
  assert.ok(h.log.aborted.includes('poster:k0') && h.log.aborted.includes('motion:k0'))
  assert.ok(!h.log.poster.includes('k7') || h.sched.snapshot().queued.poster <= 1)
  const snap = h.sched.snapshot()
  assert.equal(snap.inflight.poster, 6, 'freed slot refilled')
  assert.ok(!h.log.poster.slice(6).includes('k7'), 'unregistered queued item never starts')
})

test('VS-6 leaving to off removes queued (not in-flight) work; re-entering re-queues on request', async () => {
  const h = harness({ infoPosterChain: false })
  const els = Array.from({ length: 8 }, (_, i) => el(i))
  els.forEach((e, i) => { h.sched.register(`k${i}`, e, { animated: true }); h.obs.enter(e, 'visible') })
  for (let i = 0; i < 8; i += 1) h.sched.request(`k${i}`, 'poster')
  await flush()
  assert.equal(h.sched.snapshot().queued.poster, 2)
  h.obs.leave(els[7]); h.obs.leave(els[0])
  await flush()
  assert.equal(h.sched.snapshot().queued.poster, 1, 'queued k7 dropped')
  assert.equal(h.sched.snapshot().inflight.poster, 6, 'in-flight k0 not aborted by scrolling away')
  assert.equal(h.log.aborted.length, 0)
  h.obs.enter(els[7], 'near'); await flush()
  assert.equal(h.sched.snapshot().queued.poster, 2, 'parked request becomes eligible again')
})

test('VS-7 2,000 registered tiles with 12 visible + 24 near → motion starts ≤ 36 over the whole run, info batches bounded, never 2,000', async () => {
  const h = harness({ autoPoster: true, autoMotion: true, infoPosterChain: false })
  const els = Array.from({ length: 2000 }, (_, i) => el(i))
  els.forEach((e, i) => h.sched.register(`k${i}`, e, { animated: true }))
  for (let i = 0; i < 12; i += 1) h.obs.enter(els[i], 'visible')
  for (let i = 12; i < 36; i += 1) h.obs.enter(els[i], 'near')
  for (let i = 0; i < 2000; i += 1) { h.sched.request(`k${i}`, 'info'); h.sched.request(`k${i}`, 'motion') }
  for (let round = 0; round < 40; round += 1) await flush()
  assert.ok(h.log.motion.length <= 36, `motion starts ${h.log.motion.length}`)
  assert.equal(h.log.motion.length, 36)
  const infoKeys = h.log.info.flat()
  assert.equal(infoKeys.length, 36)
  assert.ok(h.log.info.length <= Math.ceil(36 / 64) + 1)
  assert.equal(h.sched.snapshot().parked.motion, 2000 - 36)
  assert.equal(h.sched.stats().started.motion, 36)
})

test('VS-8 done(kind, key) frees a slot even if the callback promise never settles', async () => {
  const h = harness({ infoPosterChain: false })
  const els = Array.from({ length: 8 }, (_, i) => el(i))
  els.forEach((e, i) => { h.sched.register(`k${i}`, e, { animated: true }); h.obs.enter(e, 'visible') })
  for (let i = 0; i < 8; i += 1) h.sched.request(`k${i}`, 'poster')
  await flush()
  assert.equal(h.log.poster.length, 6)
  h.sched.done('poster', 'k3')
  await flush()
  assert.equal(h.log.poster.length, 7)
  assert.equal(h.sched.snapshot().inflight.poster, 6)
})

test('VS-9 order within a band follows registration (DOM) order regardless of request order', async () => {
  const h = harness({ infoPosterChain: false })
  const els = Array.from({ length: 10 }, (_, i) => el(i))
  els.forEach((e, i) => { h.sched.register(`k${i}`, e, { animated: true }); h.obs.enter(e, 'visible') })
  for (let i = 9; i >= 0; i -= 1) h.sched.request(`k${i}`, 'poster')
  await flush()
  assert.deepEqual(h.log.poster, ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'])
})

test('VS-10 reducedMotion meta → no motion work is ever queued or started for that tile; poster still runs', async () => {
  const h = harness({ autoPoster: true, autoMotion: true, infoPosterChain: false })
  const a = el(1)
  h.sched.register('rm', a, { animated: true, reducedMotion: true }); h.obs.enter(a, 'visible')
  h.sched.request('rm', 'poster'); h.sched.request('rm', 'motion'); h.sched.hover('rm', true)
  await flush()
  assert.deepEqual(h.log.poster, ['rm']); assert.deepEqual(h.log.motion, [])
  assert.equal(h.sched.snapshot().queued.motion, 0); assert.equal(h.sched.snapshot().parked.motion, 0)
})

test('VS-11 no polling storm: a request for the same key/kind while queued or in flight is a no-op; onInfo rejection does not stall the lane', async () => {
  const h = harness({ infoPosterChain: false })
  const a = el(1)
  h.sched.register('k', a, { animated: true }); h.obs.enter(a, 'visible')
  for (let i = 0; i < 50; i += 1) h.sched.request('k', 'poster')
  await flush()
  assert.deepEqual(h.log.poster, ['k'])
  let calls = 0
  const obs = fakeObservers()
  const s2 = mod.createMediaScheduler({ createObserver: obs.createObserver, onInfo: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return new Map() }, onPoster: async () => {}, onMotion: async () => {} })
  const b = el(2), c = el(3)
  s2.register('x', b, {}); s2.register('y', c, {}); obs.enter(b, 'visible')
  s2.request('x', 'info'); await flush()
  obs.enter(c, 'visible'); s2.request('y', 'info'); await flush()
  assert.equal(calls, 2, 'lane continues after a rejected batch')
  assert.equal(s2.snapshot().inflight.info, 0)
  s2.dispose()
})
