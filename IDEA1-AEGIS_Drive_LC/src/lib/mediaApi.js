// src/lib/mediaApi.js — AEGIS Drive (IDEA1) · media-info client ของกริด Files (spec §14.1, plan Task 11)
//
// ⚠️ กติกาที่พิสูจน์ด้วยเทสต์ (tests/filesMediaTiles.test.js MA-*):
//    - ทุกคำขอไปที่ POST /api/files/media-info/batch เท่านั้น — ไม่มี GET ต่อไทล์ (ไม่มี N+1)
//    - รวมคำขอในหนึ่ง tick เป็นชุด ≤ 64 id และมี "หนึ่ง" batch ในอากาศเสมอ (ชุดถัดไปรอชุดก่อนหน้า)
//    - URL ของ poster/motion ที่เซิร์ฟเวอร์ให้มาเป็น "ของทึบ": ฝั่งนี้ไม่ประกอบ query ตัวตน (sha/profile) เองเด็ดขาด —
//      สิ่งเดียวที่ทำคือ "ฐานของแอป": เซิร์ฟเวอร์ตอบ path แบบ mount-agnostic (/api/files/…) ส่วนเบราว์เซอร์ต้องขอผ่าน
//      ฐานที่แอปถูก mount (Production = /drive/ ดู vite.config.js) จึงแปลงด้วย apiUrl() ตัวเดิม ณ จุดเดียวนี้ (Production
//      browser acceptance ล้มเพราะ <img src> ชี้ไป /api/… นอก /drive/); query/ตัวตน/ลำดับไม่ถูกแตะ; null คง null
//    - PENDING/RETRYABLE ถูก poll ซ้ำแบบมีขอบเขต: ใช้ retryAfterMs ของเซิร์ฟเวอร์ก่อน แล้วทวีคูณจนเพดาน 15 s
//      หยุดหลัง 120 s ต่อ id (listener ได้ stalled:true) — retryPending(id) เริ่มรอบใหม่ได้หนึ่งครั้งต่อการเรียก
//    - ความล้มเหลวของเครือข่าย/เซิร์ฟเวอร์ = ค่า {status:'FAILED'} ไม่ใช่ promise ที่ reject เข้า React
import { apiFetch, apiUrl } from './api.js'

export const MEDIA_INFO_BATCH_MAX = 64
export const MEDIA_INFO_BATCH_PATH = '/api/files/media-info/batch'
export const POLL_BACKOFF_CAP_MS = 15_000
export const POLL_MAX_PENDING_MS = 120_000
const POLLABLE = new Set(['PENDING', 'RETRYABLE', 'PARTIAL'])

/**
 * แปลง path ของ derivative จากเซิร์ฟเวอร์เป็น URL ที่เบราว์เซอร์ต้องขอ (ฐานของแอปเท่านั้น)
 * - ไม่ใช่สตริง/ว่าง → null; URL สัมบูรณ์ (มี scheme) → ไม่แตะ; path ที่ขึ้นต้นด้วยฐานอยู่แล้ว → ไม่เติมซ้ำ (ไม่มี /drive/drive/)
 */
export function resolveDerivativeUrl(pathname, resourceUrl = apiUrl) {
  if (typeof pathname !== 'string' || pathname.length === 0) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathname) || pathname.startsWith('//')) return pathname
  if (!pathname.startsWith('/')) return pathname
  const base = resourceUrl('/')
  if (base && base !== '/' && pathname.startsWith(base)) return pathname
  return resourceUrl(pathname)
}

const failed = (id, reason) => ({ id, status: 'FAILED', reason, poster: { state: 'GENERATION_FAILED', url: null }, motion: { state: 'GENERATION_FAILED', url: null } })
const normalise = (id, item, resourceUrl) => {
  if (!item || typeof item !== 'object') return failed(id, 'malformed')
  if (item.status === 'NOT_FOUND') return { status: 'NOT_FOUND', id }
  const out = { ...item, id: item.id ?? id }
  // ฐานของแอป: เก็บ path เดิมไว้เป็น serverPath (อ้างอิง) และให้ url เป็นสิ่งที่เบราว์เซอร์ขอได้จริง
  for (const kind of ['poster', 'motion']) {
    const sub = out[kind]
    if (sub && typeof sub === 'object' && 'url' in sub) out[kind] = { ...sub, serverPath: typeof sub.url === 'string' ? sub.url : null, url: resolveDerivativeUrl(sub.url, resourceUrl) }
  }
  return out
}
/** PARTIAL (poster พร้อม motion ยังไม่พร้อม) นับเป็น pollable เฉพาะเมื่อ motion ยังทำอยู่จริง */
const shouldPoll = (info) => info.status === 'PENDING' || info.status === 'RETRYABLE' || (info.status === 'PARTIAL' && ['PENDING', 'RETRYABLE'].includes(info.motion?.state))

/**
 * @param {{ fetchImpl?: Function, resourceUrl?: (path: string) => string, now?: () => number, setTimeoutFn?: Function, clearTimeoutFn?: Function,
 *           maxBatch?: number, maxPendingMs?: number, backoffCapMs?: number }} o — resourceUrl: ฐานของแอป (ค่าเริ่มต้น apiUrl ของ Production)
 */
export function createMediaInfoClient({
  fetchImpl = apiFetch, resourceUrl = apiUrl, now = () => Date.now(), setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id),
  maxBatch = MEDIA_INFO_BATCH_MAX, maxPendingMs = POLL_MAX_PENDING_MS, backoffCapMs = POLL_BACKOFF_CAP_MS,
} = {}) {
  /** id → [{ resolve, signal }] ที่รอ batch ถัดไป */
  const waiting = new Map()
  let flushScheduled = false
  let inflight = null
  const stats = { batches: 0, ids: 0 }
  /** id → { listeners:Set, timer, attempt, since, stalled } */
  const subs = new Map()

  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => { flushScheduled = false; flush() })
  }

  function flush() {
    if (inflight || waiting.size === 0) return
    const ids = []
    for (const [id, entries] of waiting) {
      const live = entries.filter((e) => !e.signal?.aborted)
      if (live.length === 0) { waiting.delete(id); continue }
      ids.push(id)
      if (ids.length >= maxBatch) break
    }
    if (ids.length === 0) return
    const batch = new Map()
    for (const id of ids) { batch.set(id, waiting.get(id)); waiting.delete(id) }
    stats.batches += 1; stats.ids += ids.length
    inflight = Promise.resolve()
      .then(() => fetchImpl(MEDIA_INFO_BATCH_PATH, { method: 'POST', body: { ids } }))
      .then((res) => {
        const items = res?.ok && res.data && typeof res.data.items === 'object' ? res.data.items : null
        for (const [id, entries] of batch) {
          const info = items ? normalise(id, items[id], resourceUrl) : failed(id, res?.errorKind ?? 'server')
          for (const e of entries) e.resolve(info)
        }
      }, (err) => {
        for (const [id, entries] of batch) for (const e of entries) e.resolve(failed(id, err?.name === 'AbortError' ? 'aborted' : 'network'))
      })
      .finally(() => { inflight = null; if (waiting.size) scheduleFlush() })
  }

  /**
   * ขอ media-info ของหนึ่ง id — รวมเข้า batch ของ tick นี้; ไม่ reject (ยกเลิก → {status:'CANCELLED'})
   * @returns {Promise<object>}
   */
  function request(id, { signal } = {}) {
    const key = String(id)
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve({ id: key, status: 'CANCELLED' })
      const entry = { resolve, signal }
      if (signal) signal.addEventListener('abort', () => { entry.signal = { aborted: true }; resolve({ id: key, status: 'CANCELLED' }) }, { once: true })
      if (!waiting.has(key)) waiting.set(key, [])
      waiting.get(key).push(entry)
      scheduleFlush()
    })
  }

  /* ── subscriptions with bounded polling ─────────────────────────────── */
  function clearTimer(sub) { if (sub.timer != null) { clearTimeoutFn(sub.timer); sub.timer = null } }
  function emit(id, info) { const sub = subs.get(id); if (!sub) return; for (const fn of [...sub.listeners]) { try { fn(info) } catch { /* listener ของ UI ห้ามพังการ poll */ } } }
  async function poll(id) {
    const sub = subs.get(id)
    if (!sub) return
    sub.timer = null
    const info = await request(id)
    const still = subs.get(id)
    if (!still || still !== sub) return
    if (info.status === 'CANCELLED') return
    if (shouldPoll(info)) {
      const elapsed = now() - sub.since
      if (elapsed >= maxPendingMs) { sub.stalled = true; emit(id, { ...info, stalled: true }); return }
      // รอบแรกเชื่อเซิร์ฟเวอร์ (retryAfterMs) จากนั้นทวีคูณจากค่านั้นจนถึงเพดาน — ไม่มี polling storm
      const serverHint = Number.isFinite(info.retryAfterMs) && info.retryAfterMs > 0 ? info.retryAfterMs : (Number.isFinite(info.poster?.retryAfterMs) ? info.poster.retryAfterMs : 1000)
      const delay = sub.attempt === 0 ? serverHint : Math.min(backoffCapMs, Math.max(serverHint, sub.lastDelay * 2))
      sub.attempt += 1; sub.lastDelay = delay
      emit(id, info)
      sub.timer = setTimeoutFn(() => poll(id), delay)
      return
    }
    emit(id, info)
  }
  /** สมัครรับ media-info ของ id (poll เองจนกว่าจะพร้อม/ล้มเหลว/หยุด) — คืนฟังก์ชันยกเลิก */
  function subscribe(id, listener) {
    const key = String(id)
    let sub = subs.get(key)
    if (!sub) {
      sub = { listeners: new Set(), timer: null, attempt: 0, lastDelay: 0, since: now(), stalled: false }
      subs.set(key, sub)
      poll(key)
    }
    sub.listeners.add(listener)
    return () => {
      const cur = subs.get(key)
      if (!cur) return
      cur.listeners.delete(listener)
      if (cur.listeners.size === 0) { clearTimer(cur); subs.delete(key) }
    }
  }
  /** ผู้ใช้ชี้/ขอใหม่หลังการ poll หยุด — เริ่มรอบใหม่ "หนึ่งครั้ง" (ไม่ใช่ปลดขอบเขตถาวร) */
  function retryPending(id) {
    const key = String(id)
    const sub = subs.get(key)
    if (!sub || sub.timer != null) return false
    sub.attempt = 0; sub.lastDelay = 0; sub.since = now(); sub.stalled = false
    poll(key)
    return true
  }
  function cancel(id) {
    const key = String(id)
    const entries = waiting.get(key)
    if (entries) { waiting.delete(key); for (const e of entries) e.resolve({ id: key, status: 'CANCELLED' }) }
    const sub = subs.get(key)
    if (sub) { clearTimer(sub); subs.delete(key) }
  }
  function dispose() { for (const id of [...subs.keys()]) cancel(id); for (const id of [...waiting.keys()]) cancel(id) }

  return Object.freeze({
    request, subscribe, retryPending, cancel, dispose,
    stats: () => ({ ...stats, inflight: inflight ? 1 : 0, waiting: waiting.size, subscriptions: subs.size }),
  })
}
