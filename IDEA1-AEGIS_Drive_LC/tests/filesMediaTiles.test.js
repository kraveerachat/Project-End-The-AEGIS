// tests/filesMediaTiles.test.js — AEGIS Drive (IDEA1) · media tiles ของหน้า Files (Tranche B)
//
//   MA · media-info client: batch ≤ 64, coalesce, one in flight, backoff ที่มีขอบเขต, URL ทึบ (ไม่ประกอบ v=/p= เอง)
//   TS · pure tile state machine: ตัวตน = sha (ไม่ใช่ชื่อ), poster ไม่มีวันหายเพราะ motion, first-hover race (Round 10)
//   UH · React hook (B3)    GI · Files screen integration (B4)
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'
const t = makeT('en')

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let vite, mediaApi, mediaTile, mediaThumb
before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  mediaApi = await vite.ssrLoadModule('/src/lib/mediaApi.js')
  mediaTile = await vite.ssrLoadModule('/src/lib/mediaTile.js')
  mediaThumb = await vite.ssrLoadModule('/src/components/MediaThumb.jsx')
})
after(async () => { await vite?.close() })

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const infoReady = (id, { animated = false, motion = 'READY', family = 'png', poster = 'READY' } = {}) => ({
  id, sourceVersion: SHA_A, profile: 'v1', family, animated, status: 'READY',
  poster: { state: poster, url: poster === 'READY' ? `/api/files/${id}/poster?v=${SHA_A}&p=v1` : null, mime: 'image/webp', width: 640, height: 360 },
  motion: animated
    ? { state: motion, url: motion === 'READY' ? `/api/files/${id}/motion-preview?v=${SHA_A}&p=v1` : null, reason: motion === 'UNSUPPORTED' ? 'DECODER_UNAVAILABLE' : null }
    : { state: 'UNSUPPORTED', reason: 'NOT_ANIMATED', url: null },
})
const infoPending = (id, retryAfterMs = 1000) => ({ id, sourceVersion: SHA_A, profile: 'v1', status: 'PENDING', retryAfterMs, poster: { state: 'PENDING', url: null, retryAfterMs }, motion: { state: 'PENDING', url: null } })

/** clock + timers ปลอมที่ควบคุมได้ */
function fakeClock() {
  let now = 0
  const timers = []
  const api = {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn, id: timers.length + 1 }; timers.push(t); return t.id },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        now = due.at
        await due.fn()
        await Promise.resolve(); await Promise.resolve()
      }
      now = target
    },
    pending: () => timers.length,
  }
  return api
}

/** fetch ปลอมของ apiFetch: บันทึกทุกคำขอ; ตอบตาม handler */
function fakeFetch(handler) {
  const calls = []
  let inflight = 0, maxInflight = 0
  const fetchImpl = async (pathname, opts = {}) => {
    calls.push({ path: pathname, method: opts.method ?? 'GET', body: opts.body })
    inflight += 1; maxInflight = Math.max(maxInflight, inflight)
    try { return await handler(pathname, opts) } finally { inflight -= 1 }
  }
  return { fetchImpl, calls, maxInflight: () => maxInflight }
}
const batchOk = (mk) => async (pathname, opts) => {
  assert.equal(pathname, '/api/files/media-info/batch'); assert.equal(opts.method, 'POST')
  const items = {}
  for (const id of opts.body.ids) items[id] = mk(id)
  return { ok: true, status: 200, data: { items } }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)) }

/* ════════════════════════════════════════════════════════════════════════════
   MA · media-info client
   ═══════════════════════════════════════════════════════════════════════════ */
test('MA-1 70 ids requested in one tick → two POST batches (64 + 6), never more than one in flight', async () => {
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => infoReady(id)))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const ids = Array.from({ length: 70 }, (_, i) => `f${i}`)
  const results = await Promise.all(ids.map((id) => client.request(id)))
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls.map((c) => c.body.ids.length), [64, 6])
  assert.ok(f.calls.every((c) => c.path === '/api/files/media-info/batch' && c.method === 'POST'))
  assert.equal(f.maxInflight(), 1)
  assert.equal(results[0].status, 'READY'); assert.equal(results[69].id, 'f69')
  assert.equal(mediaApi.MEDIA_INFO_BATCH_MAX, 64)
})

test('MA-2 responses are dispatched per id; NOT_FOUND propagates as {status:NOT_FOUND}; the same id twice in a tick is one request', async () => {
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => (id === 'gone' ? { status: 'NOT_FOUND' } : infoReady(id, { animated: true }))))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const [a, b, gone] = await Promise.all([client.request('a'), client.request('a'), client.request('gone')])
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].body.ids.sort(), ['a', 'gone'])
  assert.equal(a, b)
  assert.equal(a.motion.url, `/api/files/a/motion-preview?v=${SHA_A}&p=v1`)
  assert.deepEqual(gone, { status: 'NOT_FOUND', id: 'gone' })
})

test('MA-3 pending backoff: server retryAfterMs first, then doubling to a 15 s ceiling; stops after 120 s; retryPending restarts once', async () => {
  const clock = fakeClock()
  let mode = 'pending'
  const f = fakeFetch(batchOk((id) => (mode === 'pending' ? infoPending(id, 1000) : infoReady(id))))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const seen = []
  const unsubscribe = client.subscribe('p1', (info) => seen.push({ at: clock.now(), status: info.status, stalled: info.stalled ?? false }))
  await flush()
  assert.equal(f.calls.length, 1, 'first request immediately')
  const expectDelays = [1000, 2000, 4000, 8000, 15000, 15000, 15000]
  let elapsed = 0
  for (const d of expectDelays) {
    const before = f.calls.length
    await clock.advance(d - 1); await flush()
    assert.equal(f.calls.length, before, `no poll before ${d} ms`)
    await clock.advance(1); await flush()
    assert.equal(f.calls.length, before + 1, `poll at +${d} ms`)
    elapsed += d
  }
  // จนถึงตอนนี้ ~60 s; ยังไม่ครบ 120 s → ยัง poll อยู่; ข้ามไปเกิน 120 s → ต้องหยุด (ไม่มี fetch เพิ่ม)
  const atSixty = f.calls.length
  await clock.advance(120_000); await flush()
  const afterStop = f.calls.length
  assert.ok(afterStop > atSixty, 'kept polling up to the ceiling')
  const before = f.calls.length
  await clock.advance(60_000); await flush()
  assert.equal(f.calls.length, before, 'no polling after maxPendingMs')
  assert.equal(seen.at(-1).stalled, true, 'listener told the poll stalled')
  // retryPending → หนึ่งรอบใหม่ (กลับไปเริ่ม backoff ใหม่) → เจอ READY → หยุดเอง
  mode = 'ready'
  client.retryPending('p1'); await flush()
  assert.equal(f.calls.length, before + 1)
  assert.equal(seen.at(-1).status, 'READY')
  await clock.advance(200_000); await flush()
  assert.equal(f.calls.length, before + 1, 'READY ends polling')
  unsubscribe()
  assert.equal(clock.pending(), 0, 'unsubscribe leaves no timer')
  assert.ok(elapsed > 0)
})

test('MA-3b RETRYABLE honours the server retryAfterMs and stays bounded; unsubscribe cancels a scheduled poll', async () => {
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => ({ id, sourceVersion: SHA_A, profile: 'v1', status: 'RETRYABLE', reason: 'QUEUE_FULL', retryAfterMs: 15000, poster: { state: 'RETRYABLE', url: null, retryAfterMs: 15000 }, motion: { state: 'PENDING', url: null } })))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const unsub = client.subscribe('r1', () => {})
  await flush()
  await clock.advance(14_999); await flush()
  assert.equal(f.calls.length, 1)
  await clock.advance(1); await flush()
  assert.equal(f.calls.length, 2)
  unsub()
  await clock.advance(100_000); await flush()
  assert.equal(f.calls.length, 2, 'no polls after unsubscribe')
})

test('MA-4 network error / non-ok → resolves {status:FAILED} (never rejects into React); the batch does not poison other ids', async () => {
  const clock = fakeClock()
  let fail = true
  const f = fakeFetch(async () => (fail ? { ok: false, status: 0, data: null, errorKind: 'network' } : { ok: true, status: 200, data: { items: { x: infoReady('x') } } }))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const r = await client.request('x')
  assert.equal(r.status, 'FAILED'); assert.equal(r.reason, 'network')
  fail = false
  const r2 = await client.request('x')
  assert.equal(r2.status, 'READY')
  // 403/500 เช่นกัน
  const g = fakeFetch(async () => ({ ok: false, status: 503, data: { error: 'x' }, errorKind: 'server' }))
  const c2 = mediaApi.createMediaInfoClient({ fetchImpl: g.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const r3 = await c2.request('y')
  assert.equal(r3.status, 'FAILED'); assert.equal(r3.reason, 'server')
})

test('MA-5 URLs are opaque: the client never builds ?v= / &p= itself, and hands the server URLs through untouched', async () => {
  const src = await fs.readFile(new URL('../src/lib/mediaApi.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /[?&]v=/)
  assert.doesNotMatch(src, /[?&]p=/)
  assert.doesNotMatch(src, /\/poster\?|\/motion-preview\?|['"`]\/poster|['"`]\/motion-preview/, 'no derivative URL is assembled client-side')
  assert.doesNotMatch(src, /\/preview['"`]/, 'no original preview route in the media client')
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => ({ ...infoReady(id, { animated: true }), poster: { state: 'READY', url: '/opaque/poster/x?zzz=1' }, motion: { state: 'READY', url: '/opaque/motion/x' } })))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const r = await client.request('x')
  assert.equal(r.poster.url, '/opaque/poster/x?zzz=1'); assert.equal(r.motion.url, '/opaque/motion/x')
})

test('MA-6 cancel(id) / an aborted request drops interest before the batch fires; a batch with no interested ids is never sent', async () => {
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => infoReady(id)))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const ctrl = new AbortController()
  const p = client.request('c1', { signal: ctrl.signal })
  ctrl.abort()
  const r = await p
  assert.equal(r.status, 'CANCELLED')
  await flush()
  assert.equal(f.calls.length, 0, 'nothing fetched for a cancelled-only tick')
})

/* ════════════════════════════════════════════════════════════════════════════
   TS · pure tile state machine
   ═══════════════════════════════════════════════════════════════════════════ */
const T = () => mediaTile
const init = (over = {}) => T().initialTileState({ contentId: SHA_A, family: 'gif', ...over })
const run = (state, events) => events.reduce((s, e) => T().tileReducer(s, e), state)

test('TS-1 initial state', () => {
  const s = init()
  assert.equal(s.contentId, SHA_A)
  assert.deepEqual([s.info, s.poster, s.motion, s.hover, s.band, s.reducedMotion], ['unknown', 'none', 'none', false, 'off', false])
  assert.equal(T().selectors.shouldPlay(s), false)
  assert.equal(T().selectors.posterSrc(s), null)
  assert.equal(T().selectors.wantsInfo(s, 0), false, 'off band asks nothing')
})

test('TS-2 visible → wantsInfo; INFO_LOADED poster READY → poster loading with the opaque src; POSTER_LOADED → shown', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }])
  assert.equal(T().selectors.wantsInfo(s, 0), true)
  s = run(s, [{ type: 'INFO_REQUESTED' }])
  assert.equal(s.info, 'loading'); assert.equal(T().selectors.wantsInfo(s, 0), false)
  s = run(s, [{ type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }])
  assert.equal(s.info, 'ready'); assert.equal(s.poster, 'loading')
  assert.equal(T().selectors.posterSrc(s), `/api/files/f/poster?v=${SHA_A}&p=v1`)
  s = run(s, [{ type: 'POSTER_LOADED' }])
  assert.equal(s.poster, 'shown')
  assert.deepEqual(T().selectors.dataAttrs(s), { 'data-poster': 'shown', 'data-motion': 'none', 'data-info': 'ready' })
})

test('TS-3 poster never disappears: after POSTER_LOADED no event except CONTENT_CHANGED moves poster away from shown (200 random sequences)', () => {
  const base = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }])
  const pool = [
    { type: 'HOVER_ENTER' }, { type: 'HOVER_LEAVE' }, { type: 'VISIBILITY', band: 'off' }, { type: 'VISIBILITY', band: 'near' }, { type: 'VISIBILITY', band: 'visible' },
    { type: 'INFO_LOADED', info: infoPending('f'), now: 10 }, { type: 'INFO_LOADED', info: { id: 'f', status: 'GENERATION_FAILED', reason: 'DECODE_FAILED', poster: { state: 'GENERATION_FAILED' }, motion: { state: 'GENERATION_FAILED' } }, now: 20 },
    { type: 'INFO_FAILED', reason: 'network' }, { type: 'MOTION_REQUESTED' }, { type: 'MOTION_READY' }, { type: 'MOTION_ERROR' }, { type: 'PLAY_REJECTED' },
    { type: 'REDUCED_MOTION', value: true }, { type: 'REDUCED_MOTION', value: false }, { type: 'POSTER_ERROR' }, { type: 'INFO_REQUESTED' },
    { type: 'INFO_LOADED', info: { id: 'f', status: 'UNSUPPORTED', reason: 'UNSUPPORTED_TYPE', poster: { state: 'UNSUPPORTED' }, motion: { state: 'UNSUPPORTED' } }, now: 30 },
    { type: 'CONTENT_CHANGED', contentId: SHA_A, family: 'gif' },
  ]
  let seed = 42
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < 200; i += 1) {
    let s = base
    const trail = []
    for (let k = 0; k < 12; k += 1) {
      const e = pool[Math.floor(rnd() * pool.length)]
      trail.push(e.type)
      s = T().tileReducer(s, e)
      assert.equal(s.poster, 'shown', `poster vanished after ${trail.join(' → ')}`)
      assert.equal(T().selectors.posterSrc(s), `/api/files/f/poster?v=${SHA_A}&p=v1`)
    }
  }
})

test('TS-4 wantsMotionPrefetch: animated + motion READY + visible/near + !reducedMotion; off band or reducedMotion → false; still image → never', () => {
  const ready = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }])
  assert.equal(T().selectors.wantsMotionPrefetch(ready), true)
  assert.equal(T().selectors.wantsMotionPrefetch(run(ready, [{ type: 'VISIBILITY', band: 'near' }])), true)
  assert.equal(T().selectors.wantsMotionPrefetch(run(ready, [{ type: 'VISIBILITY', band: 'off' }])), false)
  assert.equal(T().selectors.wantsMotionPrefetch(run(ready, [{ type: 'REDUCED_MOTION', value: true }])), false)
  const still = run(init({ family: 'png' }), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f'), now: 0 }])
  assert.equal(T().selectors.wantsMotionPrefetch(still), false)
  assert.equal(T().selectors.motionSrc(still), null)
  // motion UNSUPPORTED (เช่น animated WebP บน toolchain ที่ไม่มี demuxer) → poster ใช้ได้ แต่ไม่มี motion ตลอดไป และไม่มี loop
  const degraded = run(init({ family: 'webp' }), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true, motion: 'UNSUPPORTED', family: 'webp' }), now: 0 }, { type: 'POSTER_LOADED' }, { type: 'HOVER_ENTER' }])
  assert.equal(degraded.poster, 'shown')
  assert.equal(T().selectors.wantsMotionPrefetch(degraded), false)
  assert.equal(T().selectors.hoverPromote(degraded), false)
  assert.equal(T().selectors.shouldPlay(degraded), false)
  assert.equal(T().selectors.dataAttrs(degraded)['data-motion'], 'none')
  assert.equal(T().selectors.motionAvailability(degraded), 'unsupported')
})

test('TS-5 first-hover race (Round 10 defect): hover while motion is still prefetching → no play, poster shown; MOTION_READY → play WITHOUT leave/enter', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }, { type: 'MOTION_REQUESTED' }])
  assert.equal(s.motion, 'prefetching')
  s = run(s, [{ type: 'HOVER_ENTER' }])
  assert.equal(s.hover, true)
  assert.equal(T().selectors.shouldPlay(s), false)
  assert.equal(s.poster, 'shown')
  s = run(s, [{ type: 'MOTION_READY' }])
  assert.equal(T().selectors.shouldPlay(s), true, 'auto-starts when the proxy becomes ready while the pointer is still inside')
  assert.equal(T().selectors.dataAttrs(s)['data-motion'], 'playing')
  assert.equal(s.poster, 'shown', 'poster stays beneath the playing overlay')
})

test('TS-5b first hover before info exists: HOVER_ENTER → INFO PENDING → INFO READY → MOTION_REQUESTED → MOTION_READY → shouldPlay (sequence from the brief)', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'HOVER_ENTER' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: { ...infoReady('f', { animated: true }), status: 'PARTIAL', motion: { state: 'PENDING', url: null } }, now: 0 }, { type: 'POSTER_LOADED' }])
  assert.equal(s.hover, true); assert.equal(T().selectors.shouldPlay(s), false); assert.equal(s.poster, 'shown')
  s = run(s, [{ type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 5000 }])
  assert.equal(T().selectors.hoverPromote(s), true, 'hover promotes the motion fetch as soon as the URL is known')
  s = run(s, [{ type: 'MOTION_REQUESTED' }, { type: 'MOTION_READY' }])
  assert.equal(T().selectors.shouldPlay(s), true)
  s = run(s, [{ type: 'HOVER_LEAVE' }])
  assert.equal(T().selectors.shouldPlay(s), false)
  assert.equal(s.motion, 'ready', 'leave keeps the fetched proxy (no refetch)')
  assert.equal(s.poster, 'shown')
})

test('TS-6/7 HOVER_LEAVE stops play and keeps motion ready; hover with motion none → prefetching at hover priority', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }])
  assert.equal(s.motion, 'none')
  s = run(s, [{ type: 'HOVER_ENTER' }])
  assert.equal(T().selectors.hoverPromote(s), true)
  assert.equal(T().selectors.wantsMotionPrefetch(s), true)
  s = run(s, [{ type: 'MOTION_REQUESTED' }, { type: 'MOTION_READY' }])
  assert.equal(T().selectors.shouldPlay(s), true)
  s = run(s, [{ type: 'HOVER_LEAVE' }])
  assert.equal(T().selectors.shouldPlay(s), false); assert.equal(s.motion, 'ready'); assert.equal(s.poster, 'shown')
  assert.equal(T().selectors.dataAttrs(s)['data-motion'], 'ready')
})

test('TS-8 reduced motion: shouldPlay false even while hovering with motion ready; no prefetch wanted', () => {
  let s = run(init(), [{ type: 'REDUCED_MOTION', value: true }, { type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }, { type: 'HOVER_ENTER' }])
  assert.equal(T().selectors.wantsMotionPrefetch(s), false)
  assert.equal(T().selectors.hoverPromote(s), false)
  s = run(s, [{ type: 'MOTION_REQUESTED' }, { type: 'MOTION_READY' }])
  assert.equal(T().selectors.shouldPlay(s), false)
  assert.equal(s.poster, 'shown')
})

test('TS-9 CONTENT_CHANGED with a new sha resets everything to initial (new contentId); the same sha (rename) is a no-op', () => {
  const s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }, { type: 'MOTION_REQUESTED' }, { type: 'MOTION_READY' }, { type: 'HOVER_ENTER' }])
  const same = T().tileReducer(s, { type: 'CONTENT_CHANGED', contentId: SHA_A, family: 'gif' })
  assert.equal(same, s, 'rename keeps state by identity')
  const changed = T().tileReducer(s, { type: 'CONTENT_CHANGED', contentId: SHA_B, family: 'gif' })
  assert.equal(changed.contentId, SHA_B)
  assert.deepEqual([changed.info, changed.poster, changed.motion], ['unknown', 'none', 'none'])
  assert.equal(T().selectors.posterSrc(changed), null)
  assert.equal(changed.band, 'visible', 'viewport band is not content state')
  assert.equal(changed.hover, true, 'pointer position is not content state')
  assert.equal(changed.reducedMotion, s.reducedMotion)
})

test('TS-10 unsupported / failed are remembered (no re-request); pending waits for retryAfter (nextInfoAt)', () => {
  const vis = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }])
  const uns = run(vis, [{ type: 'INFO_LOADED', info: { id: 'f', status: 'UNSUPPORTED', reason: 'UNSUPPORTED_TYPE', poster: { state: 'UNSUPPORTED' }, motion: { state: 'UNSUPPORTED' } }, now: 0 }])
  assert.equal(uns.info, 'unsupported'); assert.equal(T().selectors.wantsInfo(uns, 999_999), false)
  assert.equal(T().selectors.wantsInfo(run(uns, [{ type: 'VISIBILITY', band: 'off' }, { type: 'VISIBILITY', band: 'visible' }]), 999_999), false)
  const failed = run(vis, [{ type: 'INFO_LOADED', info: { id: 'f', status: 'GENERATION_FAILED', reason: 'DECODE_FAILED', poster: { state: 'GENERATION_FAILED' }, motion: { state: 'GENERATION_FAILED' } }, now: 0 }])
  assert.equal(failed.info, 'failed'); assert.equal(T().selectors.wantsInfo(failed, 999_999), false)
  assert.equal(T().selectors.dataAttrs(failed)['data-poster'], 'icon')
  const disabled = run(vis, [{ type: 'INFO_LOADED', info: { id: 'f', status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED', poster: { state: 'UNSUPPORTED' }, motion: { state: 'UNSUPPORTED' } }, now: 0 }])
  assert.equal(disabled.info, 'unsupported'); assert.equal(disabled.reason, 'MEDIA_DISABLED')
  const pending = run(vis, [{ type: 'INFO_LOADED', info: infoPending('f', 3000), now: 1000 }])
  assert.equal(pending.info, 'pending'); assert.equal(pending.nextInfoAt, 4000)
  assert.equal(T().selectors.wantsInfo(pending, 3999), false)
  assert.equal(T().selectors.wantsInfo(pending, 4000), true)
  const netFail = run(vis, [{ type: 'INFO_FAILED', reason: 'network', now: 0 }])
  assert.equal(netFail.info, 'failed')
})

test('TS-11 MOTION_ERROR / PLAY_REJECTED → motion failed for this content, no retry wanted, poster unaffected', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }, { type: 'MOTION_REQUESTED' }, { type: 'MOTION_ERROR' }, { type: 'HOVER_ENTER' }])
  assert.equal(s.motion, 'failed'); assert.equal(s.poster, 'shown')
  assert.equal(T().selectors.wantsMotionPrefetch(s), false); assert.equal(T().selectors.shouldPlay(s), false)
  assert.equal(T().selectors.dataAttrs(s)['data-motion'], 'failed')
  s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true }), now: 0 }, { type: 'POSTER_LOADED' }, { type: 'MOTION_REQUESTED' }, { type: 'MOTION_READY' }, { type: 'HOVER_ENTER' }, { type: 'PLAY_REJECTED' }])
  assert.equal(T().selectors.shouldPlay(s), false); assert.equal(s.poster, 'shown'); assert.equal(s.motion, 'failed')
})

test('TS-12 dataAttrs vocabulary; TS-13 video family idles on the poster and never yields a /preview URL', () => {
  const s0 = init({ family: 'mp4' })
  assert.deepEqual(T().selectors.dataAttrs(s0), { 'data-poster': 'icon', 'data-motion': 'none', 'data-info': 'unknown' })
  const s1 = run(s0, [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }])
  assert.equal(T().selectors.dataAttrs(s1)['data-info'], 'loading')
  const s2 = run(s1, [{ type: 'INFO_LOADED', info: infoReady('v', { animated: true, family: 'mp4' }), now: 0 }])
  assert.equal(T().selectors.dataAttrs(s2)['data-poster'], 'loading')
  assert.equal(T().selectors.posterSrc(s2), `/api/files/v/poster?v=${SHA_A}&p=v1`)
  assert.equal(T().selectors.motionSrc(s2), null, 'motion src only once a prefetch is wanted/requested')
  const s3 = run(s2, [{ type: 'POSTER_LOADED' }, { type: 'MOTION_REQUESTED' }])
  assert.equal(T().selectors.motionSrc(s3), `/api/files/v/motion-preview?v=${SHA_A}&p=v1`)
  for (const st of [s0, s1, s2, s3]) {
    for (const sel of ['posterSrc', 'motionSrc']) {
      const v = T().selectors[sel](st)
      assert.ok(v === null || !String(v).includes('/preview'), `${sel} must never point at the original preview route`)
    }
  }
  assert.deepEqual(T().TILE_DATA_VOCAB, {
    poster: ['icon', 'loading', 'shown'], motion: ['none', 'prefetching', 'ready', 'playing', 'failed'], info: ['unknown', 'loading', 'ready', 'pending', 'unsupported', 'failed'],
  })
})

test('TS-14 badge selector: GIF / APNG / animated WebP / AVIF → animated badge keys; video → badgeVideo; still → none; strings exist in en/th/zh', () => {
  const sel = T().selectors
  assert.equal(sel.badgeKey(init({ family: 'gif' })), 'badgeGif')
  assert.equal(sel.badgeKey(init({ family: 'mp4' })), 'badgeVideo')
  assert.equal(sel.badgeKey(init({ family: 'webm' })), 'badgeVideo')
  assert.equal(sel.badgeKey(init({ family: 'png' })), null)
  const apng = run(init({ family: 'png' }), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true, family: 'png' }), now: 0 }])
  assert.equal(sel.badgeKey(apng), 'badgeAnimated')
  const webp = run(init({ family: 'webp' }), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoReady('f', { animated: true, family: 'webp', motion: 'UNSUPPORTED' }), now: 0 }])
  assert.equal(sel.badgeKey(webp), 'badgeAnimated')
  for (const key of ['mediaPending', 'mediaUnsupported', 'badgeGif', 'badgeVideo', 'badgeAnimated']) {
    for (const lang of LANGS) assert.equal(typeof STRINGS[lang][key], 'string', `${lang}.${key}`)
  }
})

/* ════════════════════════════════════════════════════════════════════════════
   UH · React hook + MediaThumb (B3) — jsdom
   ═══════════════════════════════════════════════════════════════════════════ */

function installDom({ reducedMotion = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = (q) => ({ matches: reducedMotion && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })
  const previous = new Map()
  const globals = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  for (const [key, value] of Object.entries(globals)) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }) }
  const media = { calls: [], rejectPlay: false }
  const proto = w.HTMLMediaElement.prototype
  proto.play = function () { media.calls.push('play'); return media.rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve() }
  proto.pause = function () { media.calls.push('pause') }
  return { dom, W: w, media, restore() { for (const [k, d] of previous) { if (d === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, d) } w.close() } }
}
async function mountRoot(opts) {
  const env = installDom(opts)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  const render = (el) => act(async () => { root.render(el) })
  // React ผูก mouseenter/leave ผ่าน mouseover/mouseout — ยิงคู่กันเหมือน harness เดิม
  const mouse = (node, type) => act(async () => {
    const pre = type === 'mouseenter' ? 'mouseover' : type === 'mouseleave' ? 'mouseout' : null
    if (pre) node.dispatchEvent(new env.W.MouseEvent(pre, { bubbles: true, cancelable: true }))
    node.dispatchEvent(new env.W.MouseEvent(type, { bubbles: true, cancelable: true }))
  })
  const fire = (node, type) => act(async () => { node.dispatchEvent(new env.W.Event(type, { bubbles: false })) })
  let mounted = true
  return { env, W: env.W, media: env.media, root, render, mouse, fire, unmount: async () => { if (!mounted) return; mounted = false; await act(async () => root.unmount()); env.restore() } }
}
/** scheduler ปลอมที่บันทึกการเรียก และให้เทสต์ "เริ่มงาน" เอง (startPoster/startMotion) */
function stubScheduler() {
  const calls = { register: [], unregister: [], request: [], hover: [], done: [] }
  const metas = new Map()
  const s = {
    calls, metas,
    register(key, el, meta) { calls.register.push({ key, el, meta }); metas.set(key, meta); return () => s.unregister(key) },
    unregister(key) { calls.unregister.push(key); metas.delete(key) },
    request(key, kind) { calls.request.push(kind + ':' + key); return true },
    cancel() {}, hover(key, on) { calls.hover.push([key, on]) }, setMeta(key, patch) { const m = metas.get(key); if (m) metas.set(key, { ...m, ...patch }) }, done(kind, key) { calls.done.push(kind + ':' + key) },
    bandOf() { return 'visible' }, snapshot() { return {} }, dispose() {},
    band(key, band) { metas.get(key)?.onBand?.(band) },
    info(key, info) { metas.get(key)?.onInfo?.(info) },
    startPoster(key) { const ctrl = new AbortController(); return metas.get(key)?.onPoster?.(key, { signal: ctrl.signal }) },
    startMotion(key) { const ctrl = new AbortController(); return metas.get(key)?.onMotion?.(key, { signal: ctrl.signal }) },
  }
  return s
}
const fileGif = (over = {}) => ({ id: 'g1', name: 'loop.gif', kind: 'file', type: 'Image', ext: 'gif', size: 10, sha256: SHA_A, vault: false, ...over })
const thumb = (file, sched, extra = {}) => React.createElement(mediaThumb.MediaProvider, { scheduler: sched, client: { request: async () => ({}) } },
  React.createElement(mediaThumb.MediaThumb, { t, file, Icon: () => React.createElement('span', { 'data-icon': 'x' }), ...extra }))
const box = () => document.querySelector('[data-media-thumb]')

test('UH-1 mount registers with the scheduler under a key carrying the content id; unmount unregisters; a new sha re-registers', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif(), s))
    assert.equal(s.calls.register.length, 1)
    assert.ok(s.calls.register[0].key.includes(SHA_A))
    assert.ok(s.calls.register[0].el instanceof m.W.HTMLElement)
    assert.equal(s.calls.register[0].meta.animated, undefined, 'animation is the server probe decision, not the extension')
    await m.render(thumb(fileGif({ name: 'renamed.gif' }), s))
    assert.equal(s.calls.register.length, 1, 'rename keeps the registration')
    await m.render(thumb(fileGif({ sha256: SHA_B }), s))
    assert.equal(s.calls.unregister.length, 1); assert.equal(s.calls.register.length, 2); assert.ok(s.calls.register[1].key.includes(SHA_B))
    await m.unmount()
    assert.equal(s.calls.unregister.length, 2)
  } finally { await m.unmount() }
})

test('UH-2 band → info request → onInfo READY → poster fetch only when the scheduler starts it → onLoad marks shown; no /preview URL', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif(), s))
    const key = s.calls.register[0].key
    assert.deepEqual(box().getAttribute('data-poster'), 'icon')
    assert.equal(s.calls.request.length, 0, 'off band: nothing requested')
    await act(async () => s.band(key, 'visible'))
    assert.deepEqual(s.calls.request, ['info:' + key])
    assert.equal(box().getAttribute('data-info'), 'loading')
    await act(async () => s.info(key, infoReady('g1', { animated: true })))
    assert.equal(box().getAttribute('data-info'), 'ready')
    assert.ok(s.calls.request.includes('poster:' + key), 'poster requested through the scheduler')
    assert.equal(document.querySelector('img'), null, 'img not mounted before the scheduler grants the slot')
    let posterDone
    await act(async () => { posterDone = s.startPoster(key) })
    const img = document.querySelector('img')
    assert.ok(img); assert.equal(img.getAttribute('src'), '/api/files/g1/poster?v=' + SHA_A + '&p=v1')
    assert.equal(box().getAttribute('data-poster'), 'loading')
    await m.fire(img, 'load')
    assert.equal(box().getAttribute('data-poster'), 'shown')
    await posterDone
    assert.ok(document.querySelector('[data-icon]'), 'base icon remains mounted beneath the poster')
    assert.equal(document.querySelector('img[src*="/preview"]'), null)
  } finally { await m.unmount() }
})

test('UH-3 video props: muted, playsInline, loop, preload auto, aria-hidden, no controls/autoplay; src only once motion starts; canplaythrough → MOTION ready', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif(), s))
    const key = s.calls.register[0].key
    await act(async () => s.band(key, 'visible'))
    await act(async () => s.info(key, infoReady('g1', { animated: true })))
    await act(async () => { s.startPoster(key) })
    await m.fire(document.querySelector('img'), 'load')
    assert.ok(s.calls.request.includes('motion:' + key), 'visible animated tile prefetches motion (bounded by the scheduler)')
    assert.equal(document.querySelector('video'), null, 'video not mounted until the scheduler starts the fetch')
    await act(async () => { s.startMotion(key) })
    const v = document.querySelector('video')
    assert.ok(v)
    assert.equal(v.getAttribute('src'), '/api/files/g1/motion-preview?v=' + SHA_A + '&p=v1')
    assert.equal(v.muted, true); assert.equal(v.hasAttribute('playsinline'), true); assert.equal(v.hasAttribute('loop'), true)
    assert.equal(v.getAttribute('preload'), 'auto'); assert.equal(v.getAttribute('aria-hidden'), 'true'); assert.equal(v.getAttribute('tabindex'), '-1')
    assert.equal(v.hasAttribute('controls'), false); assert.equal(v.hasAttribute('autoplay'), false)
    assert.equal(box().getAttribute('data-motion'), 'prefetching')
    await m.fire(v, 'canplaythrough')
    assert.equal(box().getAttribute('data-motion'), 'ready')
    assert.deepEqual(m.media.calls, [], 'no play without hover')
    assert.equal(box().getAttribute('data-poster'), 'shown')
  } finally { await m.unmount() }
})

test('UH-4 first-hover race end-to-end: hover before canplaythrough → no play; canplaythrough → play() once; leave → pause + currentTime 0, poster still there', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif(), s))
    const key = s.calls.register[0].key
    await act(async () => s.band(key, 'visible'))
    await act(async () => s.info(key, infoReady('g1', { animated: true })))
    await act(async () => { s.startPoster(key) })
    await m.fire(document.querySelector('img'), 'load')
    await act(async () => { s.startMotion(key) })
    const v = document.querySelector('video')
    await m.mouse(box(), 'mouseenter')
    assert.deepEqual(s.calls.hover.at(-1), [key, true])
    assert.deepEqual(m.media.calls, [], 'not ready yet → no play')
    assert.equal(box().getAttribute('data-motion'), 'prefetching')
    await m.fire(v, 'canplaythrough')
    assert.deepEqual(m.media.calls, ['play'], 'auto-starts when ready while still hovered — no re-enter needed')
    assert.equal(box().getAttribute('data-motion'), 'playing')
    assert.equal(v.style.opacity, '1')
    assert.ok(document.querySelector('img'), 'poster stays mounted beneath')
    v.currentTime = 2.5
    await m.mouse(box(), 'mouseleave')
    assert.deepEqual(m.media.calls, ['play', 'pause'])
    assert.equal(v.currentTime, 0)
    assert.equal(box().getAttribute('data-motion'), 'ready')
    assert.equal(v.style.opacity, '0')
    assert.equal(document.querySelector('img').getAttribute('src'), '/api/files/g1/poster?v=' + SHA_A + '&p=v1')
    assert.deepEqual(s.calls.hover.at(-1), [key, false])
  } finally { await m.unmount() }
})

test('UH-4b play() rejection: poster stays, no crash, motion marked failed for this content', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    m.media.rejectPlay = true
    await m.render(thumb(fileGif(), s))
    const key = s.calls.register[0].key
    await act(async () => s.band(key, 'visible'))
    await act(async () => s.info(key, infoReady('g1', { animated: true })))
    await act(async () => { s.startPoster(key) })
    await m.fire(document.querySelector('img'), 'load')
    await act(async () => { s.startMotion(key) })
    await m.fire(document.querySelector('video'), 'canplaythrough')
    await m.mouse(box(), 'mouseenter')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    assert.equal(box().getAttribute('data-motion'), 'failed')
    assert.equal(box().getAttribute('data-poster'), 'shown')
    assert.ok(document.querySelector('img'))
  } finally { await m.unmount() }
})

test('UH-5 reduced motion: poster works, motion never requested, hover never plays; no <video> mounted', async () => {
  const m = await mountRoot({ reducedMotion: true }); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif(), s))
    const key = s.calls.register[0].key
    assert.equal(s.calls.register[0].meta.reducedMotion, true)
    await act(async () => s.band(key, 'visible'))
    await act(async () => s.info(key, infoReady('g1', { animated: true })))
    await act(async () => { s.startPoster(key) })
    await m.fire(document.querySelector('img'), 'load')
    assert.equal(box().getAttribute('data-poster'), 'shown')
    await m.mouse(box(), 'mouseenter')
    assert.ok(!s.calls.request.includes('motion:' + key))
    assert.equal(document.querySelector('video'), null)
    assert.deepEqual(m.media.calls, [])
  } finally { await m.unmount() }
})

test('UH-6 unsupported / disabled / pending / failed render: icon stays, truthful badge, no poster or motion request; pending shows the pending label', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif({ id: 'u1', name: 'notes.txt', ext: 'txt', type: 'Text' }), s))
    assert.equal(s.calls.register.length, 0, 'non-previewable types never register media work')
    assert.equal(box().getAttribute('data-info'), 'unsupported')
    await m.render(thumb(fileGif(), s))
    const key = s.calls.register[0].key
    await act(async () => s.band(key, 'visible'))
    await act(async () => s.info(key, { id: 'g1', status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED', poster: { state: 'UNSUPPORTED' }, motion: { state: 'UNSUPPORTED' } }))
    assert.equal(box().getAttribute('data-info'), 'unsupported'); assert.equal(box().getAttribute('data-poster'), 'icon')
    assert.ok(box().textContent.includes('GIF'), 'GIF badge from strings')
    assert.ok(!s.calls.request.some((r) => r.startsWith('poster') || r.startsWith('motion')))
    await m.render(thumb(fileGif({ sha256: SHA_B }), s))
    const key2 = s.calls.register[1].key
    await act(async () => s.band(key2, 'visible'))
    await act(async () => s.info(key2, infoPending('g1', 2000)))
    assert.equal(box().getAttribute('data-info'), 'pending')
    assert.ok(box().textContent.includes(t('mediaPending')))
    await act(async () => s.info(key2, { id: 'g1', status: 'GENERATION_FAILED', reason: 'DECODE_FAILED', poster: { state: 'GENERATION_FAILED' }, motion: { state: 'GENERATION_FAILED' } }))
    assert.equal(box().getAttribute('data-info'), 'failed'); assert.equal(box().getAttribute('data-poster'), 'icon')
    assert.equal(document.querySelector('img'), null)
  } finally { await m.unmount() }
})

test('UH-7 vault items and folders never register media work and keep the icon', async () => {
  const m = await mountRoot(); const s = stubScheduler()
  try {
    await m.render(thumb(fileGif({ vault: true }), s))
    assert.equal(s.calls.register.length, 0)
    assert.equal(box().getAttribute('data-thumb'), 'icon')
    await m.render(thumb(fileGif({ kind: 'folder', ext: '', name: 'dir' }), s))
    assert.equal(s.calls.register.length, 0)
  } finally { await m.unmount() }
})
