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
let vite, mediaApi, mediaTile, mediaThumb, filesScreen
before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  mediaApi = await vite.ssrLoadModule('/src/lib/mediaApi.js')
  mediaTile = await vite.ssrLoadModule('/src/lib/mediaTile.js')
  mediaThumb = await vite.ssrLoadModule('/src/components/MediaThumb.jsx')
  filesScreen = await vite.ssrLoadModule('/src/screens/Files.jsx')
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
   BP · derivative URLs resolved through the application base (Production /drive/ mount) — client contracts
   ═══════════════════════════════════════════════════════════════════════════ */
const mounted = (p) => `/drive/${p.replace(/^\/+/, '')}`
const POSTER_PATH = `/api/files/17/poster?v=${SHA_A}&p=v1`
const MOTION_PATH = `/api/files/17/motion-preview?v=${SHA_A}&p=v1`

test('BP-1/2/3 media-info poster and motion paths become browser URLs under the application base with the query string byte-for-byte preserved', async () => {
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => ({ ...infoReady(id, { animated: true, family: 'gif' }), poster: { state: 'READY', url: POSTER_PATH, mime: 'image/webp' }, motion: { state: 'READY', url: MOTION_PATH } })))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, resourceUrl: mounted, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const r = await client.request('17')
  assert.equal(r.poster.url, `/drive${POSTER_PATH}`)
  assert.equal(r.motion.url, `/drive${MOTION_PATH}`)
  assert.equal(r.poster.url.slice(r.poster.url.indexOf('?')), POSTER_PATH.slice(POSTER_PATH.indexOf('?')), 'query untouched')
  assert.equal(r.poster.serverPath, POSTER_PATH, 'the server path is kept verbatim for reference')
})

test('BP-4 no double prefix: a path that already carries the base is left alone; BP-5 null/absent URLs stay null; standalone base is the identity', async () => {
  const clock = fakeClock()
  const f = fakeFetch(batchOk((id) => ({ ...infoReady(id, { animated: true, family: 'gif' }), poster: { state: 'READY', url: `/drive${POSTER_PATH}` }, motion: { state: 'PENDING', url: null } })))
  const client = mediaApi.createMediaInfoClient({ fetchImpl: f.fetchImpl, resourceUrl: mounted, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  const r = await client.request('17')
  assert.equal(r.poster.url, `/drive${POSTER_PATH}`)
  assert.doesNotMatch(r.poster.url, /\/drive\/drive\//)
  assert.equal(r.motion.url, null)
  const g = fakeFetch(batchOk((id) => ({ ...infoReady(id, { animated: false }), poster: { state: 'READY', url: POSTER_PATH } })))
  const standalone = mediaApi.createMediaInfoClient({ fetchImpl: g.fetchImpl, resourceUrl: (p) => p, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout })
  assert.equal((await standalone.request('17')).poster.url, POSTER_PATH)
})

test('BP-6/7 the client resolves only the base: it never assembles v=/p= and never touches the original /preview route; the default resolver is apiUrl', async () => {
  const src = await fs.readFile(new URL('../src/lib/mediaApi.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /[?&]v=|[?&]p=|\/poster\?|\/motion-preview\?|\/preview['"`]/)
  assert.match(src, /resourceUrl = apiUrl/, 'production default = apiUrl (import.meta.env.BASE_URL aware)')
  assert.match(src, /import \{[^}]*apiUrl[^}]*\} from '\.\/api\.js'/)
  assert.equal(mediaApi.resolveDerivativeUrl(POSTER_PATH, mounted), `/drive${POSTER_PATH}`)
  assert.equal(mediaApi.resolveDerivativeUrl(null, mounted), null)
  assert.equal(mediaApi.resolveDerivativeUrl(`/drive${POSTER_PATH}`, mounted), `/drive${POSTER_PATH}`)
  assert.equal(mediaApi.resolveDerivativeUrl('https://cdn.example/x', mounted), 'https://cdn.example/x', 'absolute URLs pass through untouched')
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
  const bands = new Map()
  const s = {
    calls, metas,
    register(key, el, meta) { calls.register.push({ key, el, meta }); metas.set(key, meta); bands.set(key, 'off'); return () => s.unregister(key) },
    unregister(key) { calls.unregister.push(key); metas.delete(key); bands.delete(key) },
    request(key, kind) { calls.request.push(kind + ':' + key); return true },
    cancel() {}, hover(key, on) { calls.hover.push([key, on]) }, setMeta(key, patch) { const m = metas.get(key); if (m) metas.set(key, { ...m, ...patch }) }, done(kind, key) { calls.done.push(kind + ':' + key) },
    bandOf(key) { return bands.get(key) ?? 'off' }, snapshot() { return {} }, dispose() {},
    band(key, band) { bands.set(key, band); metas.get(key)?.onBand?.(band) },
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

/* ════════════════════════════════════════════════════════════════════════════
   GI · Files screen integration (B4/B5) — real FilesSections + fetch log + fake IntersectionObserver
   ═══════════════════════════════════════════════════════════════════════════ */

const NOW = 1_800_000_000_000
const fileItem = (over = {}) => ({ id: 'f1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf', size: 1024, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null, sha256: SHA_A, ...over })
const folderItem = (over = {}) => ({ id: 'd1', name: '01', kind: 'folder', type: 'Folder', ext: '', size: 0, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null, ...over })
const png = (over = {}) => fileItem({ id: 'p1', name: 'photo.png', type: 'Image', ext: 'png', ...over })
const gifItem = (over = {}) => fileItem({ id: 'g1', name: 'loop.gif', type: 'Image', ext: 'gif', ...over })
const mp4 = (over = {}) => fileItem({ id: 'v1', name: 'clip.mp4', type: 'Video', ext: 'mp4', ...over })
const txt = (over = {}) => fileItem({ id: 'x1', name: 'notes.txt', type: 'Text', ext: 'txt', ...over })
const noop = () => {}

/** fake IntersectionObserver ที่เทสต์ขับเอง + fetch log สำหรับ apiFetch */
function installGrid({ reducedMotion = false, info } = {}) {
  const env = installDom({ reducedMotion })
  const W = env.W
  const instances = []
  class FakeIO {
    constructor(cb, opts = {}) { this.cb = cb; this.rootMargin = opts.rootMargin ?? '0px'; this.els = new Set(); instances.push(this) }
    observe(el) { this.els.add(el) }
    unobserve(el) { this.els.delete(el) }
    disconnect() { this.els.clear() }
  }
  const prevIO = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: FakeIO })
  W.IntersectionObserver = FakeIO
  const fire = (rootMargin, el, on) => { for (const io of instances) if (io.rootMargin === rootMargin && io.els.has(el)) io.cb([{ target: el, isIntersecting: on }]) }
  const NEAR = '50% 0px 50% 0px'
  const enter = (el, band) => { if (band === 'visible') { fire(NEAR, el, true); fire('0px', el, true) } else if (band === 'near') { fire('0px', el, false); fire(NEAR, el, true) } else { fire('0px', el, false); fire(NEAR, el, false) } }
  const fetched = []
  const prevFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const infoFor = info ?? ((id) => infoReady(id, { animated: false }))
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (url, opts = {}) => {
    const u = String(url)
    fetched.push({ url: u, method: opts.method ?? 'GET' })
    if (u.endsWith('/api/files/media-info/batch')) {
      const ids = JSON.parse(opts.body).ids
      const items = {}
      for (const id of ids) items[id] = infoFor(id)
      return { ok: true, status: 200, json: async () => ({ items }), headers: new Map() }
    }
    return { ok: true, status: 200, json: async () => ({}), headers: new Map() }
  } })
  const restore = () => {
    if (prevIO === undefined) delete globalThis.IntersectionObserver; else Object.defineProperty(globalThis, 'IntersectionObserver', prevIO)
    if (prevFetch === undefined) delete globalThis.fetch; else Object.defineProperty(globalThis, 'fetch', prevFetch)
    env.restore()
  }
  return { env, W, media: env.media, enter, fetched, instances, restore }
}

async function mountGrid(opts) {
  const g = installGrid(opts)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  const render = (el) => act(async () => { root.render(el); await flush() })
  const mouse = (node, type) => act(async () => {
    const pre = type === 'mouseenter' ? 'mouseover' : type === 'mouseleave' ? 'mouseout' : null
    if (pre) node.dispatchEvent(new g.W.MouseEvent(pre, { bubbles: true, cancelable: true }))
    node.dispatchEvent(new g.W.MouseEvent(type, { bubbles: true, cancelable: true }))
  })
  const fire = (node, type) => act(async () => { node.dispatchEvent(new g.W.Event(type, { bubbles: false })) })
  const enter = (el, band) => act(async () => { g.enter(el, band); await flush(); await flush() })
  /** หลายไทล์เข้าจอพร้อมกันใน callback เดียว — เหมือน IntersectionObserver จริง */
  const enterAll = (els, band) => act(async () => { for (const el of els) g.enter(el, band); await flush(); await flush() })
  let mounted = true
  return { ...g, root, render, mouse, fire, enter, enterAll, unmount: async () => { if (!mounted) return; mounted = false; await act(async () => root.unmount()); g.restore() } }
}
const sections = ({ folders = [], files: plain = [], selectedIds = new Set(), onSelectionChange = noop, onOpen = noop, ...rest } = {}) => React.createElement(filesScreen.FilesSections, {
  t, now: NOW, view: 'grid', folders, files: plain, selectedIds, draggingIds: [], onSelect: noop, onOpen, onMenuAction: noop,
  onDragStartItem: noop, onDropItems: noop, tileRef: () => noop, onSelectionChange, ...rest,
})
const tileOf = (id) => document.querySelector(`[data-file-id="${id}"]`)
const thumbOf = (id) => tileOf(id).querySelector('[data-media-thumb]')
const previewRequests = (g) => g.fetched.filter((f) => f.url.includes('/preview'))
const domOriginalSrcs = () => [...document.querySelectorAll('img[src], video[src], source[src]')].map((e) => e.getAttribute('src')).filter((s) => s.includes('/preview'))

test('GI-STATIC-1/2 cold png: icon first, nothing fetched off-screen; visible → one media-info batch → poster derivative <img>; no /preview request or src anywhere', async () => {
  const g = await mountGrid()
  try {
    await g.render(sections({ files: [png()] }))
    const th = thumbOf('p1')
    assert.equal(th.getAttribute('data-poster'), 'icon')
    assert.equal(g.fetched.length, 0, 'off-screen: no request at all')
    await g.enter(th, 'visible')
    const batches = g.fetched.filter((f) => f.url.endsWith('/api/files/media-info/batch'))
    assert.equal(batches.length, 1); assert.equal(batches[0].method, 'POST')
    const img = th.querySelector('img')
    assert.ok(img, 'poster img mounted from the batch answer')
    assert.equal(img.getAttribute('src'), `/api/files/p1/poster?v=${SHA_A}&p=v1`)
    await g.fire(img, 'load')
    assert.equal(th.getAttribute('data-poster'), 'shown'); assert.equal(th.getAttribute('data-thumb'), 'poster')
    assert.equal(th.querySelector('video'), null, 'still image never mounts a video')
    assert.deepEqual(previewRequests(g), []); assert.deepEqual(domOriginalSrcs(), [])
  } finally { await g.unmount() }
})

test('GI-ANIM-1/2/3 gif: idle poster is static; video mounts only after visible + motion READY; first hover before canplaythrough auto-plays when ready; leave → static poster immediately', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await g.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1')
    assert.equal(th.querySelector('video'), null)
    await g.enter(th, 'visible')
    const img = th.querySelector('img'); assert.ok(img)
    await g.fire(img, 'load')
    assert.equal(th.getAttribute('data-poster'), 'shown')
    const v = th.querySelector('video')
    assert.ok(v, 'visible animated tile prefetches its motion proxy')
    assert.equal(v.getAttribute('src'), `/api/files/g1/motion-preview?v=${SHA_A}&p=v1`)
    assert.equal(v.getAttribute('preload'), 'auto'); assert.equal(v.muted, true); assert.equal(v.hasAttribute('loop'), true); assert.equal(v.hasAttribute('playsinline'), true)
    assert.equal(v.style.opacity, '0')
    assert.equal(th.getAttribute('data-thumb'), 'poster')
    // first hover while not ready
    await g.mouse(tileOf('g1'), 'mouseenter')
    assert.deepEqual(g.media.calls, [])
    assert.equal(th.getAttribute('data-poster'), 'shown')
    await g.fire(v, 'canplaythrough')
    assert.deepEqual(g.media.calls, ['play'], 'auto-start when ready, no re-enter')
    assert.equal(th.getAttribute('data-motion'), 'playing'); assert.equal(th.getAttribute('data-thumb'), 'motion'); assert.equal(v.style.opacity, '1')
    const imgBefore = th.querySelector('img')
    v.currentTime = 1.2
    await g.mouse(tileOf('g1'), 'mouseleave')
    assert.deepEqual(g.media.calls, ['play', 'pause']); assert.equal(v.currentTime, 0)
    assert.equal(v.style.opacity, '0'); assert.equal(th.getAttribute('data-thumb'), 'poster')
    assert.equal(th.querySelector('img'), imgBefore, 'same poster element — never remounted')
    assert.deepEqual(previewRequests(g), []); assert.deepEqual(domOriginalSrcs(), [])
  } finally { await g.unmount() }
})

test('GI-VIDEO-1 mp4: idle uses the poster derivative, hover uses the motion proxy, the original video is never referenced by the tile; GI-PREVIEW-1 the Preview dialog still uses /api/files/:id/preview', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'mp4' }) })
  try {
    await g.render(sections({ files: [mp4()] }))
    const th = thumbOf('v1')
    await g.enter(th, 'visible')
    await g.fire(th.querySelector('img'), 'load')
    const v = th.querySelector('video')
    assert.equal(v.getAttribute('src'), `/api/files/v1/motion-preview?v=${SHA_A}&p=v1`)
    assert.ok(th.textContent.includes(t('badgeVideo')) || th.getAttribute('data-poster') === 'shown')
    await g.fire(v, 'canplaythrough')
    await g.mouse(tileOf('v1'), 'mouseenter')
    assert.deepEqual(g.media.calls, ['play'])
    assert.deepEqual(previewRequests(g), []); assert.deepEqual(domOriginalSrcs(), [])
    // Preview dialog = original bytes by design (explicit user action)
    await g.render(React.createElement(filesScreen.FilePreviewModal, { t, file: mp4(), onClose: noop, onDownload: noop }))
    const dialogVideo = document.querySelector('[role="dialog"] video')
    assert.ok(dialogVideo); assert.equal(dialogVideo.getAttribute('src'), '/api/files/v1/preview')
    assert.equal(dialogVideo.hasAttribute('controls'), true)
  } finally { await g.unmount() }
})

test('GI-UNSUPPORTED .txt: icon, data-info unsupported locally, no media-info request; server UNSUPPORTED_TYPE for a previewable extension is remembered (no polling)', async () => {
  const g = await mountGrid({ info: (id) => ({ id, status: 'UNSUPPORTED', reason: 'UNSUPPORTED_TYPE', poster: { state: 'UNSUPPORTED' }, motion: { state: 'UNSUPPORTED' } }) })
  try {
    await g.render(sections({ files: [txt(), png({ id: 'p2', name: 'odd.png', sha256: SHA_B })] }))
    const tx = thumbOf('x1')
    await g.enter(tx, 'visible')
    assert.equal(tx.getAttribute('data-info'), 'unsupported'); assert.equal(tx.getAttribute('data-thumb'), 'icon')
    assert.equal(g.fetched.length, 0, 'non-previewable never asks the server')
    const p2 = thumbOf('p2')
    await g.enter(p2, 'visible')
    assert.equal(g.fetched.length, 1)
    assert.equal(p2.getAttribute('data-info'), 'unsupported'); assert.equal(p2.getAttribute('data-thumb'), 'icon')
    await g.enter(p2, 'off'); await g.enter(p2, 'visible')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    assert.equal(g.fetched.length, 1, 'no re-request after UNSUPPORTED')
    assert.equal(p2.querySelector('img'), null)
  } finally { await g.unmount() }
})

test('GI-PENDING-BACKOFF pending → bounded re-polls (server retryAfterMs, doubling), never a storm; GENERATION_FAILED → icon, no more polling', async () => {
  let mode = 'pending'
  const g = await mountGrid({ info: (id) => (mode === 'pending' ? infoPending(id, 20) : { id, status: 'GENERATION_FAILED', reason: 'DECODE_FAILED', poster: { state: 'GENERATION_FAILED' }, motion: { state: 'GENERATION_FAILED' } }) })
  try {
    await g.render(sections({ files: [png()] }))
    const th = thumbOf('p1')
    await g.enter(th, 'visible')
    assert.equal(th.getAttribute('data-info'), 'pending')
    assert.ok(th.textContent.includes(t('mediaPending')))
    const batches = () => g.fetched.filter((f) => f.url.endsWith('/media-info/batch')).length
    assert.equal(batches(), 1)
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); await flush() })
    const after1s = batches()
    assert.ok(after1s >= 2 && after1s <= 3, `bounded polling in the first second (server hint 20 ms, floor 1 s doubling): ${after1s}`)
    mode = 'failed'
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); await flush() })
    assert.equal(th.getAttribute('data-info'), 'failed'); assert.equal(th.getAttribute('data-thumb'), 'icon')
    const settled = batches()
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); await flush() })
    assert.equal(batches(), settled, 'no polling after GENERATION_FAILED')
  } finally { await g.unmount() }
})

test('GI-RENAME same sha keeps the shown poster and issues no new request; GI-REPLACE a new sha resets to icon and asks again', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await g.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1')
    await g.enter(th, 'visible')
    await g.fire(th.querySelector('img'), 'load')
    assert.equal(th.getAttribute('data-poster'), 'shown')
    const before = g.fetched.length
    await g.render(sections({ files: [gifItem({ name: 'renamed.gif', modified: NOW + 1 })] }))
    assert.equal(thumbOf('g1').getAttribute('data-poster'), 'shown')
    assert.equal(thumbOf('g1').querySelector('img').getAttribute('src'), `/api/files/g1/poster?v=${SHA_A}&p=v1`)
    assert.equal(g.fetched.length, before, 'rename: no new media-info request')
    await g.render(sections({ files: [gifItem({ sha256: SHA_B })] }))
    const th2 = thumbOf('g1')
    assert.equal(th2.getAttribute('data-poster'), 'icon', 'new content → back to icon until the new derivative arrives')
    assert.ok(!th2.querySelector('img')?.getAttribute('src')?.includes(SHA_A), 'old derivative URL discarded')
    await g.enter(th2, 'visible')
    assert.equal(g.fetched.length, before + 1, 'replace: exactly one new batch')
  } finally { await g.unmount() }
})

test('GI-REDUCED prefers-reduced-motion: poster shown, no <video> ever mounted, hover does nothing; Preview menu still offered', async () => {
  const g = await mountGrid({ reducedMotion: true, info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await g.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1')
    await g.enter(th, 'visible')
    await g.fire(th.querySelector('img'), 'load')
    assert.equal(th.getAttribute('data-poster'), 'shown')
    await g.mouse(tileOf('g1'), 'mouseenter')
    await act(async () => { await flush() })
    assert.equal(th.querySelector('video'), null)
    assert.deepEqual(g.media.calls, [])
    const menu = await import('react-dom/server')
    const html = menu.renderToStaticMarkup(React.createElement(filesScreen.FileMenu, { t, file: gifItem(), onAction: noop, onClose: noop }))
    assert.ok(html.includes(t('preview')))
  } finally { await g.unmount() }
})

test('GI-BADGES gif → GIF badge, apng/animated webp → ANIMATED badge (poster-only degradation keeps the poster and never mounts a video), mp4 → VIDEO badge', async () => {
  const g = await mountGrid({ info: (id) => (id === 'w1' ? infoReady(id, { animated: true, family: 'webp', motion: 'UNSUPPORTED' }) : id === 'a1' ? infoReady(id, { animated: true, family: 'png' }) : infoReady(id, { animated: true, family: id === 'v1' ? 'mp4' : 'gif' })) })
  try {
    await g.render(sections({ files: [gifItem(), mp4(), png({ id: 'a1', name: 'anim.png', sha256: SHA_B }), png({ id: 'w1', name: 'anim.webp', ext: 'webp', sha256: 'c'.repeat(64) })] }))
    assert.ok(thumbOf('g1').textContent.includes('GIF'))
    assert.ok(thumbOf('v1').textContent.includes(t('badgeVideo')))
    const w = thumbOf('w1')
    await g.enter(w, 'visible')
    await g.fire(w.querySelector('img'), 'load')
    assert.equal(w.getAttribute('data-poster'), 'shown')
    assert.equal(w.querySelector('video'), null, 'motion UNSUPPORTED (no webp demuxer) → poster-only, no video, no loop')
    await g.mouse(tileOf('w1'), 'mouseenter'); await act(async () => { await flush() })
    assert.equal(w.querySelector('video'), null); assert.deepEqual(g.media.calls, [])
    assert.equal(w.getAttribute('data-motion'), 'none')
    const a = thumbOf('a1')
    await g.enter(a, 'visible')
    assert.ok(a.textContent.includes(t('badgeAnimated')) || a.querySelector('img'), 'apng exposes the animated badge before its poster arrives')
  } finally { await g.unmount() }
})

test('GI-DISABLED every id answers UNSUPPORTED/MEDIA_DISABLED → icon + family badge, no poster/motion elements, one batch, no polling; folder tiles unchanged', async () => {
  const g = await mountGrid({ info: (id) => ({ id, status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED', poster: { state: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' }, motion: { state: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' } }) })
  try {
    await g.render(sections({ folders: [folderItem()], files: [png(), gifItem(), mp4()] }))
    await g.enterAll(['p1', 'g1', 'v1'].map(thumbOf), 'visible')
    assert.equal(g.fetched.filter((f) => f.url.endsWith('/media-info/batch')).length, 1, 'one batch for the three visible tiles')
    for (const id of ['p1', 'g1', 'v1']) {
      const th = thumbOf(id)
      assert.equal(th.getAttribute('data-thumb'), 'icon'); assert.equal(th.getAttribute('data-info'), 'unsupported')
      assert.equal(th.querySelector('img'), null); assert.equal(th.querySelector('video'), null)
    }
    assert.ok(thumbOf('g1').textContent.includes('GIF')); assert.ok(thumbOf('v1').textContent.includes(t('badgeVideo')))
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); await flush() })
    assert.equal(g.fetched.length, 1, 'no retry storm when media is disabled')
    assert.equal(tileOf('d1').getAttribute('data-tile-variant'), 'folder-compact')
    assert.equal(tileOf('d1').querySelector('[data-media-thumb]'), null, 'folders have no media thumb')
    assert.deepEqual(previewRequests(g), []); assert.deepEqual(domOriginalSrcs(), [])
  } finally { await g.unmount() }
})

test('GI-VIEWPORT 40 gif tiles, 4 visible: one batch for the 4, motion starts ≤ 3 at a time, off-screen tiles fetch nothing', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    const items = Array.from({ length: 40 }, (_, i) => gifItem({ id: `g${i}`, name: `g${i}.gif`, sha256: String(i).padStart(64, 'e') }))
    await g.render(sections({ files: items }))
    await g.enterAll([0, 1, 2, 3].map((i) => thumbOf(`g${i}`)), 'visible')
    const batches = g.fetched.filter((f) => f.url.endsWith('/media-info/batch'))
    assert.ok(batches.length >= 1 && batches.length <= 2, `batches ${batches.length}`)
    assert.equal(document.querySelectorAll('[data-media-thumb] video').length, 3, 'motion cap of 3 in flight')
    assert.equal(document.querySelectorAll('[data-media-thumb] img').length, 4)
    for (let i = 4; i < 40; i += 1) { assert.equal(thumbOf(`g${i}`).querySelector('img'), null); assert.equal(thumbOf(`g${i}`).querySelector('video'), null) }
  } finally { await g.unmount() }
})

test('GI-REGRESSION marquee/selection scene still selects a file card; folder tile variant unchanged', async () => {
  const g = await mountGrid()
  try {
    let selected = new Set()
    const rerender = () => g.render(sections({ folders: [folderItem()], files: [png(), fileItem({ id: 'f2', name: 'b.pdf' }), fileItem({ id: 'f3', name: 'c.pdf' })], selectedIds: selected, onSelectionChange: (next) => { selected = new Set(next); rerender() } }))
    await rerender()
    const rect = (sel, r) => { const el = document.querySelector(sel); el.getBoundingClientRect = () => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y }) }
    rect('[data-marquee-canvas]', { x: 0, y: 0, w: 1000, h: 800 }); rect('[data-file-id="d1"]', { x: 20, y: 20, w: 180, h: 48 })
    rect('[data-file-id="p1"]', { x: 20, y: 120, w: 200, h: 180 }); rect('[data-file-id="f2"]', { x: 260, y: 120, w: 200, h: 180 }); rect('[data-file-id="f3"]', { x: 500, y: 120, w: 200, h: 180 })
    const pointer = (node, type, init) => act(async () => { const ev = new g.W.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }); Object.defineProperty(ev, 'pointerId', { value: 1 }); Object.defineProperty(ev, 'pointerType', { value: 'mouse' }); node.dispatchEvent(ev) })
    await pointer(document.querySelector('[data-marquee-canvas]'), 'pointerdown', { clientX: 700, clientY: 400 })
    await pointer(window, 'pointermove', { clientX: 480, clientY: 130 })
    await pointer(window, 'pointerup', { clientX: 480, clientY: 130 })
    assert.deepEqual([...selected], ['f3'])
    assert.equal(tileOf('d1').getAttribute('data-tile-variant'), 'folder-compact')
    assert.equal(tileOf('p1').getAttribute('data-tile-variant'), 'file-card')
  } finally { await g.unmount() }
})

test('GI-NO-GIFPOSTER no browser-side poster pipeline remains in the grid: no gifPoster module, no createImageBitmap/Blob poster, no /preview in thumbnail code', async () => {
  const files = await fs.readFile(new URL('../src/screens/Files.jsx', import.meta.url), 'utf8')
  const thumbSrc = await fs.readFile(new URL('../src/components/MediaThumb.jsx', import.meta.url), 'utf8')
  const hookSrc = await fs.readFile(new URL('../src/lib/useMediaTile.js', import.meta.url), 'utf8')
  assert.doesNotMatch(files, /gifPoster|createGifPoster/)
  assert.doesNotMatch(files, /createImageBitmap|toBlob|createObjectURL/)
  for (const src of [thumbSrc, hookSrc]) { assert.doesNotMatch(src, /previewPathFor|\/preview['"`]|createImageBitmap|createObjectURL/) }
  // previewPathFor ใช้ได้เฉพาะใน FilePreviewModal (ผู้ใช้กด Preview เอง) — ไม่ใช่ใน FileTile/FileListRow
  const tileStart = files.indexOf('export function FileTile(')
  const tileEnd = files.indexOf('export function FolderTile(')
  const listStart = files.indexOf('function FileListRow(')
  const listEnd = files.indexOf('export function FilesSections(')
  assert.ok(tileStart > 0 && tileEnd > tileStart && listStart > 0 && listEnd > listStart)
  assert.doesNotMatch(files.slice(tileStart, tileEnd), /previewPathFor|<img|<video/)
  assert.doesNotMatch(files.slice(listStart, listEnd), /previewPathFor|<img|<video/)
  assert.match(files, /<MediaThumb/)
  let gone = false
  try { await fs.access(new URL('../src/lib/gifPoster.js', import.meta.url)) } catch { gone = true }
  assert.equal(gone, true, 'src/lib/gifPoster.js deleted')
  const { execFileSync } = await import('node:child_process')
  // git grep exits 1 when nothing matches — that is the expected outcome here
  let grep = ''
  try {
    grep = execFileSync('git', [
      'grep', '-l', 'gifPoster', '--',
      'src/screens/Files.jsx',
      'src/components/MediaThumb.jsx',
      'src/lib/useMediaTile.js',
      'server',
    ], { cwd: path.resolve(rootDir), encoding: 'utf8' }).trim()
  } catch (err) { if (err.status !== 1) throw err }
  assert.equal(grep, '', 'the normal Files grid/server pipeline has no browser-side gifPoster implementation')
})

/* ════════════════════════════════════════════════════════════════════════════
   C0 · PARTIAL-motion polling (Tranche C) — poster READY while motion still generating must keep polling
   ═══════════════════════════════════════════════════════════════════════════ */
const infoPartial = (id, { motionState = 'PENDING', retryAfterMs = 20, topLevelRetry = undefined, family = 'gif' } = {}) => ({
  id, sourceVersion: SHA_A, profile: 'v1', family, animated: true, status: 'PARTIAL',
  ...(topLevelRetry !== undefined ? { retryAfterMs: topLevelRetry } : {}),
  poster: { state: 'READY', url: `/api/files/${id}/poster?v=${SHA_A}&p=v1`, mime: 'image/webp' },
  motion: { state: motionState, url: null, retryAfterMs, reason: motionState === 'RETRYABLE' ? 'QUEUE_FULL' : null },
})
const batchCount = (g) => g.fetched.filter((f) => f.url.endsWith('/media-info/batch')).length
const wait = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); await flush() })

test('C0-RT runtime repoll: visible → hover before motion ready → PARTIAL(poster READY, motion PENDING) → runtime sends a SECOND batch by itself → READY → video gets the opaque URL → canplay → play() with no re-enter', async () => {
  let phase = 'partial'
  const g = await mountGrid({ info: (id) => (phase === 'partial' ? infoPartial(id, { retryAfterMs: 20 }) : infoReady(id, { animated: true, family: 'gif' })) })
  try {
    await g.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1')
    await g.mouse(tileOf('g1'), 'mouseenter') // pointer in BEFORE anything is ready
    await g.enter(th, 'visible')
    assert.equal(batchCount(g), 1, 'first media-info batch')
    const img = th.querySelector('img'); assert.ok(img, 'poster from the PARTIAL answer')
    await g.fire(img, 'load')
    assert.equal(th.getAttribute('data-poster'), 'shown')
    assert.equal(th.querySelector('video'), null, 'no motion URL yet')
    assert.deepEqual(g.media.calls, [])
    phase = 'ready'
    await wait(1300) // ≥ 1 s backoff floor, no manual INFO_LOADED
    assert.equal(batchCount(g), 2, 'the runtime re-polled on its own (RED at 40658295: stays 1)')
    assert.equal(th.getAttribute('data-poster'), 'shown', 'poster never disappeared across the poll')
    const v = th.querySelector('video')
    assert.ok(v, 'scheduler released the motion slot after the READY answer')
    assert.equal(v.getAttribute('src'), `/api/files/g1/motion-preview?v=${SHA_A}&p=v1`)
    await g.fire(v, 'canplaythrough')
    assert.deepEqual(g.media.calls, ['play'], 'auto-start: pointer never left')
    assert.equal(th.getAttribute('data-motion'), 'playing')
    assert.equal(th.getAttribute('data-thumb'), 'motion')
    await wait(1300)
    assert.equal(batchCount(g), 2, 'READY ends polling')
  } finally { await g.unmount() }
})

test('C0-1/C0-3/C0-4 reducer: PARTIAL + motion PENDING stays pollable (info pending, poster shown, posterSrc unchanged); READY later supplies the opaque motion URL', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoPartial('f', { retryAfterMs: 500 }), now: 1000 }, { type: 'POSTER_LOADED' }])
  assert.equal(s.info, 'pending'); assert.equal(s.poster, 'shown')
  assert.equal(T().selectors.posterSrc(s), `/api/files/f/poster?v=${SHA_A}&p=v1`)
  assert.equal(s.nextInfoAt, 2000, 'retryAfterMs 500 < 1 s floor → +1000')
  assert.equal(T().selectors.wantsInfo(s, 1999), false); assert.equal(T().selectors.wantsInfo(s, 2000), true)
  assert.equal(T().selectors.dataAttrs(s)['data-poster'], 'shown'); assert.equal(T().selectors.dataAttrs(s)['data-info'], 'pending')
  s = run(s, [{ type: 'INFO_REQUESTED' }])
  assert.equal(s.poster, 'shown', 'poster survives the re-request')
  s = run(s, [{ type: 'INFO_LOADED', info: infoReady('f', { animated: true, family: 'gif' }), now: 2100 }])
  assert.equal(s.info, 'ready'); assert.equal(s.poster, 'shown'); assert.equal(s.motionAvailability, 'available')
  assert.equal(T().selectors.wantsMotionPrefetch(s), true)
  assert.equal(T().selectors.wantsInfo(s, 999_999), false)
})

test('C0-2 reducer: PARTIAL + motion RETRYABLE honours retryAfterMs (motion-level, then top-level), still bounded by the poll cap', () => {
  const base = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }])
  const a = run(base, [{ type: 'INFO_LOADED', info: infoPartial('f', { motionState: 'RETRYABLE', retryAfterMs: 5000 }), now: 0 }])
  assert.equal(a.info, 'pending'); assert.equal(a.nextInfoAt, 5000)
  const b = run(base, [{ type: 'INFO_LOADED', info: { ...infoPartial('f', { motionState: 'RETRYABLE', retryAfterMs: null }), retryAfterMs: 3000 }, now: 0 }])
  assert.equal(b.nextInfoAt, 3000, 'top-level retryAfterMs when the motion block has none')
  const c = run(base, [{ type: 'INFO_LOADED', info: infoPartial('f', { motionState: 'RETRYABLE', retryAfterMs: 60_000 }), now: 0 }])
  assert.equal(c.nextInfoAt, 60_000, 'server may ask for longer waits')
  let d = base
  for (let i = 0; i < 6; i += 1) d = run(d, [{ type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoPartial('f', { retryAfterMs: 1 }), now: i * 20_000 }])
  assert.equal(d.nextInfoAt - 5 * 20_000, T().PENDING_POLL_CAP_MS, 'doubling caps at PENDING_POLL_CAP_MS')
})

test('C0-6/C0-7 reducer: PARTIAL + motion UNSUPPORTED or GENERATION_FAILED is terminal (info ready, no polling loop), poster shown', () => {
  for (const motionState of ['UNSUPPORTED', 'GENERATION_FAILED']) {
    const s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoPartial('f', { motionState }), now: 0 }, { type: 'POSTER_LOADED' }])
    assert.equal(s.info, 'ready', motionState); assert.equal(s.poster, 'shown')
    assert.equal(T().selectors.wantsInfo(s, 999_999), false, `${motionState}: nothing left to discover`)
    assert.equal(s.motionAvailability, 'unsupported'); assert.equal(T().selectors.wantsMotionPrefetch(s), false)
  }
})

test('C0-8 reducer: the 120 s pending ceiling applies to PARTIAL polling too; hover restarts one round', () => {
  let s = run(init(), [{ type: 'VISIBILITY', band: 'visible' }, { type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoPartial('f'), now: 0 }, { type: 'POSTER_LOADED' }])
  for (let i = 1; i <= 12; i += 1) s = run(s, [{ type: 'INFO_REQUESTED' }, { type: 'INFO_LOADED', info: infoPartial('f'), now: i * 15_000 }])
  assert.equal(s.info, 'pending'); assert.equal(s.poster, 'shown')
  assert.equal(T().selectors.wantsInfo(s, 12 * 15_000 + 60_000), false, 'after PENDING_MAX_MS no more polls')
  s = run(s, [{ type: 'HOVER_ENTER', now: 300_000 }])
  assert.equal(T().selectors.wantsInfo(s, 300_000), true, 'hover restarts exactly one round')
  assert.equal(s.poster, 'shown')
})

test('C0-9 runtime: reduced motion — PARTIAL → READY repoll happens, poster shown, but no video and no play', async () => {
  let phase = 'partial'
  const g = await mountGrid({ reducedMotion: true, info: (id) => (phase === 'partial' ? infoPartial(id) : infoReady(id, { animated: true, family: 'gif' })) })
  try {
    await g.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1')
    await g.mouse(tileOf('g1'), 'mouseenter')
    await g.enter(th, 'visible')
    await g.fire(th.querySelector('img'), 'load')
    phase = 'ready'
    await wait(1300)
    assert.equal(batchCount(g), 2)
    assert.equal(th.getAttribute('data-poster'), 'shown')
    assert.equal(th.querySelector('video'), null)
    assert.deepEqual(g.media.calls, [])
  } finally { await g.unmount() }
})

test('C0-10 runtime: MEDIA_ENABLED=false (UNSUPPORTED/MEDIA_DISABLED) still produces exactly one batch over 1.5 s — no retry storm', async () => {
  const g = await mountGrid({ info: (id) => ({ id, status: 'UNSUPPORTED', reason: 'MEDIA_DISABLED', poster: { state: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' }, motion: { state: 'UNSUPPORTED', reason: 'MEDIA_DISABLED' } }) })
  try {
    await g.render(sections({ files: [gifItem(), mp4()] }))
    await g.mouse(tileOf('g1'), 'mouseenter')
    await g.enterAll(['g1', 'v1'].map(thumbOf), 'visible')
    await wait(1500)
    assert.equal(batchCount(g), 1)
    assert.equal(thumbOf('g1').getAttribute('data-info'), 'unsupported')
  } finally { await g.unmount() }
})

/* ════════════════════════════════════════════════════════════════════════════
   BP-INT · the real Files grid built with base '/drive/' (Production mount) — derivative URLs must carry the base
   TOUCH · press-and-hold media interaction (pointer events)   LAYOUT · controls stack above the media surface
   ═══════════════════════════════════════════════════════════════════════════ */
let viteMounted, filesMounted
before(async () => {
  viteMounted = await createServer({
    configFile: false, root: rootDir, base: '/drive/', appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  filesMounted = await viteMounted.ssrLoadModule('/src/screens/Files.jsx')
})
after(async () => { await viteMounted?.close() })
const sectionsWith = (mod, { folders = [], files: plain = [], selectedIds = new Set(), onSelectionChange = noop, onOpen = noop, ...rest } = {}) => React.createElement(mod.FilesSections, {
  t, now: NOW, view: 'grid', folders, files: plain, selectedIds, draggingIds: [], onSelect: noop, onOpen, onMenuAction: noop,
  onDragStartItem: noop, onDropItems: noop, tileRef: () => noop, onSelectionChange, ...rest,
})
const allSrcs = () => [...document.querySelectorAll('img[src], video[src]')].map((e) => e.getAttribute('src'))

test('BP-INT-STATIC mounted /drive/: media-info goes to /drive/api/…, the png poster <img> src is /drive/api/files/:id/poster?v=…&p=v1 with the query intact; no bare /api request escapes the mount', async () => {
  const g = await mountGrid()
  try {
    await g.render(sectionsWith(filesMounted, { files: [png()] }))
    const th = thumbOf('p1')
    await g.enter(th, 'visible')
    const batches = g.fetched.filter((f) => f.url.endsWith('/api/files/media-info/batch'))
    assert.equal(batches.length, 1); assert.equal(batches[0].url, '/drive/api/files/media-info/batch')
    assert.ok(g.fetched.every((f) => f.url.startsWith('/drive/')), `every request stays under /drive/: ${JSON.stringify(g.fetched)}`)
    const img = th.querySelector('img'); assert.ok(img)
    assert.equal(img.getAttribute('src'), `/drive/api/files/p1/poster?v=${SHA_A}&p=v1`)
    await g.fire(img, 'load')
    assert.equal(th.getAttribute('data-poster'), 'shown')
    assert.ok(allSrcs().every((s) => s.startsWith('/drive/api/files/') && !s.includes('/drive/drive/') && !s.includes('/preview')))
  } finally { await g.unmount() }
})

test('BP-INT-GIF mounted /drive/: poster and motion proxy both load under the base; first hover before ready still auto-plays; no /preview', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await g.render(sectionsWith(filesMounted, { files: [gifItem()] }))
    const th = thumbOf('g1')
    await g.enter(th, 'visible')
    const img = th.querySelector('img'); assert.equal(img.getAttribute('src'), `/drive/api/files/g1/poster?v=${SHA_A}&p=v1`)
    await g.fire(img, 'load')
    const v = th.querySelector('video'); assert.ok(v)
    assert.equal(v.getAttribute('src'), `/drive/api/files/g1/motion-preview?v=${SHA_A}&p=v1`)
    await g.mouse(tileOf('g1'), 'mouseenter')
    await g.fire(v, 'canplaythrough')
    assert.deepEqual(g.media.calls, ['play'])
    assert.ok(allSrcs().every((s) => s.startsWith('/drive/api/files/') && !s.includes('/preview')))
    assert.deepEqual(previewRequests(g), [])
  } finally { await g.unmount() }
})

test('BP-INT-VIDEO mounted /drive/: mp4 poster + motion under the base; Preview dialog keeps the original route under the base too', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'mp4' }) })
  try {
    await g.render(sectionsWith(filesMounted, { files: [mp4()] }))
    const th = thumbOf('v1')
    await g.enter(th, 'visible')
    assert.equal(th.querySelector('img').getAttribute('src'), `/drive/api/files/v1/poster?v=${SHA_A}&p=v1`)
    await g.fire(th.querySelector('img'), 'load')
    assert.equal(th.querySelector('video').getAttribute('src'), `/drive/api/files/v1/motion-preview?v=${SHA_A}&p=v1`)
    await g.render(React.createElement(filesMounted.FilePreviewModal, { t, file: mp4(), onClose: noop, onDownload: noop }))
    assert.equal(document.querySelector('[role="dialog"] video').getAttribute('src'), '/drive/api/files/v1/preview')
  } finally { await g.unmount() }
})

/* ── touch press-and-hold ─────────────────────────────────────────────────── */
const pointer = (g, node, type, init = {}) => act(async () => {
  const ev = new g.W.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...init })
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 7 })
  Object.defineProperty(ev, 'pointerType', { value: init.pointerType ?? 'touch' })
  node.dispatchEvent(ev)
})
const HOLD = () => filesScreen.MEDIA_HOLD_MS

test('TOUCH-1 press-and-hold on a gif tile: motion interaction becomes active after MEDIA_HOLD_MS, plays once ready, release → poster immediately; a plain tap still opens the file, a consumed hold does not', async () => {
  let opened = 0
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await g.render(sections({ files: [gifItem()], onOpen: () => { opened += 1 } }))
    const th = thumbOf('g1'); const tile = tileOf('g1')
    await g.enter(th, 'visible')
    await g.fire(th.querySelector('img'), 'load')
    const v = th.querySelector('video'); assert.ok(v)
    assert.equal(typeof HOLD(), 'number'); assert.ok(HOLD() > 0 && HOLD() <= 400, 'small fixed hold threshold')
    await pointer(g, tile, 'pointerdown')
    assert.notEqual(th.getAttribute('data-motion'), 'playing', 'no motion before the hold threshold')
    await act(async () => { await new Promise((r) => setTimeout(r, HOLD() + 60)) })
    assert.equal(th.getAttribute('data-poster'), 'shown', 'poster stays visible during the hold')
    await g.fire(v, 'canplaythrough')
    assert.deepEqual(g.media.calls, ['play'], 'motion starts while the finger is still down')
    assert.equal(th.getAttribute('data-motion'), 'playing')
    await pointer(g, tile, 'pointerup')
    assert.deepEqual(g.media.calls, ['play', 'pause'])
    assert.equal(th.getAttribute('data-thumb'), 'poster'); assert.equal(v.style.opacity, '0')
    await act(async () => { tile.dispatchEvent(new g.W.MouseEvent('click', { bubbles: true, cancelable: true })) })
    assert.equal(opened, 0, 'a click that ends a consumed hold does not open the file')
    // plain tap: down + up before the threshold, then click → opens
    await pointer(g, tile, 'pointerdown'); await pointer(g, tile, 'pointerup')
    await act(async () => { tile.dispatchEvent(new g.W.MouseEvent('click', { bubbles: true, cancelable: true })) })
    assert.equal(opened, 1)
    assert.equal(g.media.calls.length, 2, 'a tap never plays')
  } finally { await g.unmount() }
})

test('TOUCH-2 pointercancel (scroll) and pointer leave end the hold cleanly; hold before the proxy is ready auto-starts when ready; internal drag/context menu are suppressed while holding', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    let dragStarted = 0
    await g.render(sections({ files: [gifItem()], onDragStartItem: () => { dragStarted += 1 } }))
    const th = thumbOf('g1'); const tile = tileOf('g1')
    await g.enter(th, 'visible')
    await g.fire(th.querySelector('img'), 'load')
    const v = th.querySelector('video')
    // hold, then cancel before ready → nothing plays, no dangling state
    await pointer(g, tile, 'pointerdown')
    await act(async () => { await new Promise((r) => setTimeout(r, HOLD() + 60)) })
    await pointer(g, tile, 'pointercancel')
    await g.fire(v, 'canplaythrough')
    assert.deepEqual(g.media.calls, [], 'cancelled hold never plays')
    assert.equal(th.getAttribute('data-motion'), 'ready')
    // hold again: proxy is already ready → plays once threshold passes; leave ends it
    await pointer(g, tile, 'pointerdown')
    await act(async () => { await new Promise((r) => setTimeout(r, HOLD() + 60)) })
    assert.deepEqual(g.media.calls, ['play'])
    const ctx = new g.W.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => { tile.dispatchEvent(ctx) })
    assert.equal(ctx.defaultPrevented, true, 'long-press context menu suppressed while holding')
    const drag = new g.W.Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(drag, 'dataTransfer', { value: { setData() {}, types: [], effectAllowed: '' } })
    await act(async () => { tile.dispatchEvent(drag) })
    assert.equal(drag.defaultPrevented, true, 'no internal drag while holding'); assert.equal(dragStarted, 0)
    await pointer(g, tile, 'pointerout'); await pointer(g, tile, 'pointerleave') // React derives leave from out (browsers fire both)
    assert.deepEqual(g.media.calls, ['play', 'pause'])
    assert.equal(th.getAttribute('data-thumb'), 'poster')
    // short press released before the threshold never activates
    await pointer(g, tile, 'pointerdown'); await pointer(g, tile, 'pointerup')
    await act(async () => { await new Promise((r) => setTimeout(r, HOLD() + 60)) })
    assert.equal(g.media.calls.length, 2)
  } finally { await g.unmount() }
})

test('TOUCH-3 reduced motion: press-and-hold shows the poster but never plays; mouse pointer enter/leave (pointerType mouse) still drives hover', async () => {
  const g = await mountGrid({ reducedMotion: true, info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await g.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1'); const tile = tileOf('g1')
    await g.enter(th, 'visible'); await g.fire(th.querySelector('img'), 'load')
    await pointer(g, tile, 'pointerdown')
    await act(async () => { await new Promise((r) => setTimeout(r, HOLD() + 60)) })
    assert.equal(th.querySelector('video'), null); assert.deepEqual(g.media.calls, []); assert.equal(th.getAttribute('data-poster'), 'shown')
    await pointer(g, tile, 'pointerup')
  } finally { await g.unmount() }
  const h = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    await h.render(sections({ files: [gifItem()] }))
    const th = thumbOf('g1'); const tile = tileOf('g1')
    await h.enter(th, 'visible'); await h.fire(th.querySelector('img'), 'load')
    const v = th.querySelector('video'); await h.fire(v, 'canplaythrough')
    await pointer(h, tile, 'pointerover', { pointerType: 'mouse' }); await pointer(h, tile, 'pointerenter', { pointerType: 'mouse' })
    assert.deepEqual(h.media.calls, ['play'], 'mouse pointer enter = hover')
    await pointer(h, tile, 'pointerout', { pointerType: 'mouse' }); await pointer(h, tile, 'pointerleave', { pointerType: 'mouse' })
    assert.deepEqual(h.media.calls, ['play', 'pause'])
    // a touch pointer entering the card is NOT a hover (compat events must not start motion)
    await pointer(h, tile, 'pointerover', { pointerType: 'touch' }); await pointer(h, tile, 'pointerenter', { pointerType: 'touch' })
    assert.equal(h.media.calls.length, 2)
  } finally { await h.unmount() }
})

/* ── control stacking / layout ────────────────────────────────────────────── */
test('LAYOUT-1 selection and action controls live inside the media frame above the media surface (z-20 over z-0), inset 8px, and stay clickable; the poster/video never cover them', async () => {
  const g = await mountGrid({ info: (id) => infoReady(id, { animated: true, family: 'gif' }) })
  try {
    let selected = 0
    await g.render(sections({ files: [gifItem()], onSelect: () => { selected += 1 } }))
    const tile = tileOf('g1'); const th = thumbOf('g1')
    const frame = tile.querySelector('[data-media-frame]')
    assert.ok(frame, 'media frame wrapper present')
    assert.match(frame.className, /\brelative\b/)
    assert.ok(frame.contains(th), 'MediaThumb is inside the frame')
    assert.match(th.className, /\bz-0\b/)
    const checkbox = tile.querySelector('[role="checkbox"]'); const menuBtn = tile.querySelector('[aria-haspopup="menu"]')
    assert.ok(frame.contains(checkbox) && frame.contains(menuBtn), 'both controls are positioned relative to the media frame')
    for (const c of [checkbox, menuBtn]) { assert.match(c.className, /\bz-20\b/); assert.match(c.className, /\babsolute\b/); assert.match(c.className, /\btop-2\b/) }
    assert.match(checkbox.className, /\bleft-2\b/); assert.match(menuBtn.className, /\bright-2\b/)
    assert.equal(th.contains(checkbox), false, 'controls are not children of the overflow-hidden media surface')
    await g.enter(th, 'visible'); await g.fire(th.querySelector('img'), 'load')
    assert.ok(frame.querySelector('img'), 'poster inside the same frame, beneath the controls')
    await act(async () => { checkbox.dispatchEvent(new g.W.MouseEvent('click', { bubbles: true, cancelable: true })) })
    assert.equal(selected, 1, 'checkbox remains clickable above the poster')
    assert.equal(document.querySelectorAll('[data-file-id="g1"] [data-media-frame] > *').length >= 3, true)
  } finally { await g.unmount() }
})

test('LAYOUT-2 coarse pointer (touch) surfaces show the controls without hover; fine pointer keeps the hover reveal', async () => {
  const g = await mountGrid()
  try {
    await g.render(sections({ files: [png()] }))
    const tile = tileOf('p1')
    const checkbox = tile.querySelector('[role="checkbox"]')
    const menu = tile.querySelector('[aria-haspopup="menu"]')
    assert.match(checkbox.className, /\bfile-card-control\b/)
    assert.match(menu.className, /\bfile-card-control\b/)
    assert.equal(checkbox.style.opacity, '', 'visibility is owned by the shared pointer-aware CSS, not inline JS')
    assert.equal(menu.style.opacity, '', 'visibility is owned by the shared pointer-aware CSS, not inline JS')
    const css = await fs.readFile(new URL('../src/index.css', import.meta.url), 'utf8')
    assert.match(css, /\.file-card-control\s*\{[^}]*opacity:\s*1/s, 'coarse/touch default stays visible')
    assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*?\.file-card-control\s*\{[^}]*opacity:\s*0/s, 'fine pointer idle state is quiet')
    assert.match(css, /\[data-file-card-shell\]:hover\s+\.file-card-control[\s\S]*?opacity:\s*1/s, 'fine pointer hover reveals the controls')
  } finally { await g.unmount() }
})

test('UH-1b a browser without IntersectionObserver still requests visible media info', async () => {
  const m = await mountRoot()
  const calls = []
  const client = {
    request: async (id) => {
      calls.push(id)
      return { id, status: 'UNSUPPORTED', reason: 'fixture', poster: { state: 'UNSUPPORTED' }, motion: { state: 'UNSUPPORTED' } }
    },
    dispose() {},
  }
  const runtime = mediaThumb.createMediaRuntime({ client })
  try {
    await m.render(React.createElement(mediaThumb.MediaProvider, { scheduler: runtime.scheduler, client },
      React.createElement(mediaThumb.MediaThumb, { t, file: fileGif(), Icon: () => React.createElement('span') })))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.deepEqual(calls, ['g1'])
  } finally {
    runtime.dispose()
    await m.unmount()
  }
})

test('UH-1c StrictMode development remount keeps the page-owned media scheduler alive', async () => {
  const m = await mountRoot()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (pathname, opts = {}) => {
    if (pathname !== '/api/files/media-info/batch') throw new Error(`unexpected request: ${pathname}`)
    const ids = JSON.parse(opts.body).ids
    calls.push(...ids)
    return new Response(JSON.stringify({ items: ids.map((id) => ({
      id,
      status: 'UNSUPPORTED',
      reason: 'fixture',
      poster: { state: 'UNSUPPORTED' },
      motion: { state: 'UNSUPPORTED' },
    })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  function Page() {
    const runtime = mediaThumb.useOwnedMediaRuntime()
    return React.createElement(mediaThumb.MediaProvider, { scheduler: runtime.scheduler, client: runtime.client },
      React.createElement(mediaThumb.MediaThumb, { t, file: fileGif(), Icon: () => React.createElement('span') }))
  }
  try {
    await m.render(React.createElement(React.StrictMode, null, React.createElement(Page)))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.deepEqual(calls, ['g1'])
  } finally {
    globalThis.fetch = originalFetch
    await m.unmount()
  }
})
