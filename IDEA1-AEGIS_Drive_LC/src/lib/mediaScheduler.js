// src/lib/mediaScheduler.js — AEGIS Drive (IDEA1) · viewport-driven media work scheduler (spec §15.3, plan Task 12)
//
// ⚠️ ทำไมต้องมี: กริด 2,000 ไทล์ต้องไม่กลายเป็น 2,000 คำขอ motion — งานถูกจัดเป็นเลนต่อชนิด (info / poster / motion)
//    มีเพดานพร้อมกัน (info batch 1, poster 6, motion 3) และเรียงตาม "แถบ" จาก IntersectionObserver สองตัว:
//    visible (rootMargin 0px) ก่อน near (50% รอบจอ) ก่อน off (ไม่ทำเลย — เก็บไว้ "จอด" จนกว่าจะเลื่อนเข้ามา)
// ⚠️ hover = ลำดับความสำคัญสูงสุด: ขึ้นหน้าสุดทันที และถ้า motion เต็มเพดาน จะแย่ง slot ของ prefetch ที่สำคัญน้อยสุด
//    (abort ผ่าน AbortSignal แล้วเข้าคิวใหม่) — ผู้ใช้ที่ชี้อยู่ไม่ต้องรอ prefetch ของไทล์ที่ไม่ได้มอง
// ⚠️ ไม่มี URL ต้นฉบับเกี่ยวข้อง: scheduler รู้จักแค่ key (ตัวตนของไทล์) และชนิดงาน — ผู้ถือ callback เป็นคนขอทรัพยากร
// ⚠️ unregister/ออกจากจอ: งานที่รอถูกทิ้ง; งานที่กำลังทำถูก abort เฉพาะเมื่อ unregister (เลื่อนออกเฉย ๆ ให้ทำต่อจนจบ — ไม่ทิ้งของที่โหลดไปแล้ว)

export const MEDIA_SCHEDULER_CAPS = Object.freeze({ info: 1, poster: 6, motion: 3 })
export const VISIBLE_ROOT_MARGIN = '0px'
export const NEAR_ROOT_MARGIN = '50% 0px 50% 0px'
const KINDS = ['info', 'poster', 'motion']
const BAND_RANK = { visible: 0, near: 1, off: 2 }

const defaultCreateObserver = (callback, { rootMargin }) => {
  if (typeof IntersectionObserver !== 'function') return null
  return new IntersectionObserver(callback, { rootMargin, threshold: 0 })
}

/**
 * @param {{ createObserver?: Function, onInfo: (keys: string[]) => Promise<Map<string, object>|object>,
 *           onPoster: (key: string, ctx: { signal: AbortSignal }) => Promise<any>,
 *           onMotion: (key: string, ctx: { signal: AbortSignal }) => Promise<any>,
 *           caps?: { info?: number, poster?: number, motion?: number }, log?: Function }} o
 */
export function createMediaScheduler({ createObserver = defaultCreateObserver, onInfo, onPoster, onMotion, caps = {}, log = () => {} }) {
  const cap = { ...MEDIA_SCHEDULER_CAPS, ...caps }
  /** key → entry */
  const entries = new Map()
  const byEl = new Map()
  let seq = 0
  const inflight = { info: new Map(), poster: new Map(), motion: new Map() } // key → { controller, startedAt }
  const stats = { started: { info: 0, poster: 0, motion: 0 }, batches: 0, preempted: 0 }
  let pumpScheduled = false
  let disposed = false

  const observerVisible = createObserver((records) => onRecords(records, 'visible'), { rootMargin: VISIBLE_ROOT_MARGIN })
  const observerNear = createObserver((records) => onRecords(records, 'near'), { rootMargin: NEAR_ROOT_MARGIN })

  function onRecords(records, which) {
    for (const r of records) {
      const entry = byEl.get(r.target)
      if (!entry) continue
      entry[which] = Boolean(r.isIntersecting)
      const band = entry.visible ? 'visible' : entry.near ? 'near' : 'off'
      setBand(entry, band)
    }
    schedulePump()
  }
  function setBand(entry, band) {
    if (entry.band === band) return
    entry.band = band
    if (band === 'off') {
      // ออกจากจอ: งานที่ "รอ" กลับไปจอด (ยังจำว่าอยากได้) — งานที่กำลังทำปล่อยให้จบ
      for (const k of KINDS) if (entry.wanted.has(k)) entry.parked.add(k)
    } else {
      for (const k of KINDS) entry.parked.delete(k)
    }
    try { entry.meta.onBand?.(band) } catch (err) { log(`[media-scheduler] onBand failed: ${err?.message ?? err}`) }
  }

  const eligible = (entry, kind) => {
    if (kind === 'motion' && entry.meta.reducedMotion) return false
    if (entry.hover) return true
    return entry.band === 'visible' || entry.band === 'near'
  }
  /** งานที่รอ (wanted แต่ยังไม่ inflight และมีสิทธิ์ตามแถบ) เรียงตาม hover → band → ลำดับลงทะเบียน */
  function queued(kind) {
    const out = []
    for (const entry of entries.values()) {
      if (!entry.wanted.has(kind) || inflight[kind].has(entry.key)) continue
      if (!eligible(entry, kind)) continue
      out.push(entry)
    }
    out.sort((a, b) => (Number(b.hover) - Number(a.hover)) || (BAND_RANK[a.band] - BAND_RANK[b.band]) || (a.seq - b.seq))
    return out
  }
  const priorityOf = (entry) => (entry.hover ? -1 : BAND_RANK[entry.band])

  function schedulePump() {
    if (pumpScheduled || disposed) return
    pumpScheduled = true
    queueMicrotask(() => { pumpScheduled = false; pump() })
  }
  function pump() {
    if (disposed) return
    pumpInfo()
    for (const kind of ['poster', 'motion']) pumpKind(kind)
  }
  function pumpInfo() {
    if (inflight.info.size >= cap.info) return
    const batch = queued('info')
    if (batch.length === 0) return
    const controller = new AbortController()
    const keys = batch.map((e) => e.key)
    const token = { controller, keys }
    inflight.info.set('__batch__', token)
    for (const e of batch) e.wanted.delete('info')
    stats.started.info += keys.length; stats.batches += 1
    Promise.resolve()
      .then(() => onInfo(keys, { signal: controller.signal }))
      .then((result) => {
        if (!result) return
        const get = typeof result.get === 'function' ? (k) => result.get(k) : (k) => result[k]
        for (const e of batch) {
          const info = get(e.key)
          if (info !== undefined && entries.get(e.key) === e) { try { e.meta.onInfo?.(info) } catch (err) { log(`[media-scheduler] onInfo(tile) failed: ${err?.message ?? err}`) } }
        }
      })
      .catch((err) => log(`[media-scheduler] info batch failed: ${err?.message ?? err}`))
      .finally(() => { if (inflight.info.get('__batch__') === token) inflight.info.delete('__batch__'); schedulePump() })
  }
  function start(kind, entry) {
    const controller = new AbortController()
    const token = { controller, priority: priorityOf(entry), startedAt: ++seq, entry }
    inflight[kind].set(entry.key, token)
    entry.wanted.delete(kind)
    stats.started[kind] += 1
    const fn = kind === 'poster' ? (entry.meta.onPoster ?? onPoster) : (entry.meta.onMotion ?? onMotion)
    Promise.resolve()
      .then(() => fn(entry.key, { signal: controller.signal }))
      .catch((err) => { if (!controller.signal.aborted) log(`[media-scheduler] ${kind} ${entry.key} failed: ${err?.message ?? err}`) })
      .finally(() => { if (inflight[kind].get(entry.key) === token) inflight[kind].delete(entry.key); schedulePump() })
  }
  function pumpKind(kind) {
    const lane = queued(kind)
    let i = 0
    while (inflight[kind].size < cap[kind] && i < lane.length) start(kind, lane[i++])
    // hover ที่ยังรออยู่ทั้งที่เลนเต็ม: แย่ง slot ของงานที่สำคัญน้อยสุด (เฉพาะ motion — poster เล็กและใกล้จบเสมอ)
    if (kind !== 'motion') return
    for (; i < lane.length; i += 1) {
      const want = lane[i]
      if (!want.hover) break
      let victim = null
      for (const [key, token] of inflight.motion) {
        if (token.entry.hover) continue
        if (!victim || token.priority > victim.token.priority || (token.priority === victim.token.priority && token.startedAt > victim.token.startedAt)) victim = { key, token }
      }
      if (!victim) break
      stats.preempted += 1
      inflight.motion.delete(victim.key)
      victim.token.controller.abort(new Error('preempted'))
      victim.token.entry.wanted.add('motion') // เข้าคิวใหม่ตามลำดับเดิมของมัน
      start('motion', want)
    }
  }

  /* ── public ─────────────────────────────────────────────────────────── */
  function register(key, el, meta = {}) {
    if (disposed) return () => {}
    const k = String(key)
    const existing = entries.get(k)
    if (existing) unregister(k)
    const entry = { key: k, el, meta, seq: ++seq, band: 'off', visible: false, near: false, hover: false, wanted: new Set(), parked: new Set() }
    entries.set(k, entry)
    if (el) {
      byEl.set(el, entry)
      observerVisible?.observe(el)
      observerNear?.observe(el)
      // ไม่มี observer (jsdom/SSR): ถือว่ามองเห็น เพื่อไม่ให้กริดเงียบทั้งหน้า
      if (!observerVisible && !observerNear) setBand(entry, 'visible')
    }
    return () => unregister(k)
  }
  function unregister(key) {
    const k = String(key)
    const entry = entries.get(k)
    if (!entry) return
    entries.delete(k)
    if (entry.el) { byEl.delete(entry.el); observerVisible?.unobserve(entry.el); observerNear?.unobserve(entry.el) }
    for (const kind of ['poster', 'motion']) {
      const token = inflight[kind].get(k)
      if (token) { inflight[kind].delete(k); token.controller.abort(new Error('unregistered')) }
    }
    schedulePump()
  }
  /** ขอให้ทำงานชนิดนี้ให้ไทล์ key — ซ้ำขณะรอ/ทำอยู่ = ไม่ทำอะไร (ไม่มี storm) */
  function request(key, kind) {
    const entry = entries.get(String(key))
    if (!entry || !KINDS.includes(kind)) return false
    if (inflight[kind].has(entry.key)) return false
    if (kind === 'info' && inflight.info.get('__batch__')?.keys.includes(entry.key)) return false
    if (kind === 'motion' && entry.meta.reducedMotion) return false
    entry.wanted.add(kind)
    if (!eligible(entry, kind)) entry.parked.add(kind); else entry.parked.delete(kind)
    schedulePump()
    return true
  }
  function cancel(key, kind) {
    const entry = entries.get(String(key))
    if (!entry) return
    entry.wanted.delete(kind); entry.parked.delete(kind)
    const token = inflight[kind]?.get(entry.key)
    if (token) { inflight[kind].delete(entry.key); token.controller.abort(new Error('cancelled')) }
    schedulePump()
  }
  function hover(key, active) {
    const entry = entries.get(String(key))
    if (!entry) return
    entry.hover = Boolean(active)
    if (entry.hover) for (const k of KINDS) if (entry.wanted.has(k) && eligible(entry, k)) entry.parked.delete(k)
    schedulePump()
  }
  function setMeta(key, patch) {
    const entry = entries.get(String(key))
    if (!entry) return
    entry.meta = { ...entry.meta, ...patch }
    if (entry.meta.reducedMotion) { entry.wanted.delete('motion'); entry.parked.delete('motion') }
    schedulePump()
  }
  /** ปลดปล่อย slot ด้วยมือ (กัน promise ที่ไม่ settle) */
  function done(kind, key) {
    const token = inflight[kind]?.get(String(key))
    if (!token) return
    inflight[kind].delete(String(key))
    schedulePump()
  }
  function bandOf(key) { return entries.get(String(key))?.band ?? 'off' }
  function snapshot() {
    const q = { info: 0, poster: 0, motion: 0 }, parked = { info: 0, poster: 0, motion: 0 }
    for (const entry of entries.values()) {
      for (const kind of KINDS) {
        if (!entry.wanted.has(kind) || inflight[kind].has(entry.key)) continue
        if (eligible(entry, kind)) q[kind] += 1; else parked[kind] += 1
      }
    }
    return { queued: q, parked, inflight: { info: inflight.info.size, poster: inflight.poster.size, motion: inflight.motion.size }, tiles: entries.size }
  }
  function dispose() {
    disposed = true
    for (const kind of ['poster', 'motion']) for (const token of inflight[kind].values()) token.controller.abort(new Error('disposed'))
    inflight.poster.clear(); inflight.motion.clear()
    observerVisible?.disconnect(); observerNear?.disconnect()
    entries.clear(); byEl.clear()
  }

  return Object.freeze({ register, unregister, request, cancel, hover, setMeta, done, bandOf, snapshot, stats: () => ({ ...stats, started: { ...stats.started } }), dispose, caps: Object.freeze({ ...cap }) })
}
