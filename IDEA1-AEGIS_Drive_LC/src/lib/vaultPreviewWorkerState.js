// src/lib/vaultPreviewWorkerState.js — AEGIS Drive (IDEA1) · สถานะในหน่วยความจำของ Service Worker
//
// ⚠️ ทุกอย่างในนี้คือหน่วยความจำของโปรเซส worker ล้วน ๆ worker ที่ถูกปลุกใหม่คือ instance
//    ใหม่ทั้งใบ: ไม่มีกุญแจ ไม่มี plaintext ไม่มีเซสชันใดรอดข้ามการรีสตาร์ต
//    ไม่มี Cache API / IndexedDB / localStorage / sessionStorage / ดิสก์ ที่ไหนเลย
//
// ── LFT-V2-E3.3 · ทำไมต้องแยกงบเป็นสามก้อน ─────────────────────────────────
//    เดิมตัวเลขเดียว (`maxPlaintextChunks`) ทำหน้าที่ทั้ง "จำนวนก้อนที่แคชได้" และ
//    "จำนวนงานที่วิ่งพร้อมกันได้" ผลคือหน้าต่างอ่านล่วงหน้าจะกว้างขึ้นไม่ได้เลยโดยไม่
//    ทำให้เพดานหน่วยความจำโตตาม และการดึง ciphertext จึงเป็นแบบทีละก้อนตลอด
//
//    ตอนนี้แยกกันชัดเจนสามแกน:
//      1. งบไบต์ plaintext ที่ถือค้างไว้ได้   ≤ 64 MiB  (เพดานแข็ง)
//      2. จำนวนช่องแคชต่อ token              = ⌊งบไบต์ ÷ ขนาดก้อน⌋ (ครอบที่ 4)
//      3. จำนวนงานดึง ciphertext ที่วิ่งพร้อมกัน = เท่าจำนวนช่อง โดย **กันไว้หนึ่งช่อง
//         ให้ foreground เสมอ** งานเก็งล่วงหน้าจึงไม่มีทางยึดคิวจนผู้เล่นต้องรอ
import {
  PREVIEW_FAILURE_REASON, previewSessionInvalidatedError, markPreviewCancellation,
  PREVIEW_CANCELLATION,
} from './vaultPreviewErrors.js'
import { plaintextChunkSizeFor } from './vaultPreviewRange.js'
import {
  previewChunkWindow, prefetchIndexesAfter, withinReadAheadWindow,
  MAX_PREVIEW_PLAINTEXT_CACHE_BYTES, MAX_PREVIEW_PREFETCH_SLOTS,
} from './vaultPreviewReadAhead.js'

export { MAX_PREVIEW_PLAINTEXT_CACHE_BYTES, MAX_PREVIEW_PREFETCH_SLOTS }

const cacheKey = (token, index) => `${token}:${index}`

/**
 * งานเก็งล่วงหน้าที่ถูกทิ้งเพราะผู้ใช้ seek ไปที่อื่น
 * ⚠️ นับเป็น "การรื้อโดยเจตนา" ไม่ใช่ความผิดพลาดของเครือข่าย — ไม่มีใครรอผลของมัน และ
 *    มันต้องไม่ทำให้ UI ขึ้นว่า preview พัง
 */
function speculativeDiscardedError() {
  const err = Object.assign(new Error('preview read-ahead discarded'), { name: 'AbortError' })
  return markPreviewCancellation(err, PREVIEW_CANCELLATION.REQUEST)
}

export function createPreviewWorkerState({
  maxPlaintextChunks,
  maxPlaintextBytes = MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
  maxPrefetchSlots = MAX_PREVIEW_PREFETCH_SLOTS,
  onCacheEvent,
  onReadAheadEvent,
} = {}) {
  const byteLimit = Math.min(
    MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
    Math.max(1, Math.floor(Number(maxPlaintextBytes) || MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)),
  )
  // ⚠️ หน้าต่างแบบตายตัวมีไว้ให้ผู้เรียกที่ต้องการควบคุมเอง (และให้ชุดทดสอบเดิมยังตรึง
  //    พฤติกรรมเดิมได้) ถ้าไม่ระบุ หน้าต่างจะคำนวณจากขนาดก้อนจริงของเซสชันตอน open
  const fixedSlots = Number.isFinite(Number(maxPlaintextChunks))
    ? Math.max(1, Math.floor(Number(maxPlaintextChunks)))
    : null
  const fixedWindow = fixedSlots === null ? null : {
    cacheSlots: fixedSlots,
    prefetchAhead: fixedSlots - 1,
    maxInFlight: fixedSlots,
    maxSpeculativeInFlight: Math.max(0, fixedSlots - 1),
    maxTotalInFlight: fixedSlots > 1 ? fixedSlots + 1 : fixedSlots,
    plaintextCeilingBytes: byteLimit,
    ciphertextCeilingBytes: byteLimit,
  }

  const sessions = new Map()
  const cache = new Map()
  const recoveries = new Map()
  const tokenEpochs = new Map()
  const windows = new Map()
  const foregrounds = new Map()
  // ⚠️ Ownership of an in-flight ciphertext load belongs to the *session*, never
  //    to whichever Range response happened to trigger it. Two overlapping
  //    Chromium ranges routinely wait on one shared chunk Promise; if that load
  //    carried request A's AbortSignal, Chromium cancelling A would reject the
  //    shared Promise and destroy request B's perfectly valid range too.
  //    Only deliberate teardown — close, lock, closeAll, replacement — aborts.
  const sessionAborters = new Map()
  const schedulers = new Map()
  let globalEpoch = 0
  let discardedSpeculative = 0

  const tokenEpoch = (token) => tokenEpochs.get(token) ?? 0
  const bumpToken = (token) => tokenEpochs.set(token, tokenEpoch(token) + 1)
  const lifecycleMatches = (token, session, startedTokenEpoch, startedGlobalEpoch) => (
    globalEpoch === startedGlobalEpoch
    && tokenEpoch(token) === startedTokenEpoch
    && sessions.get(token) === session
  )

  const windowOf = (token) => windows.get(token) ?? fixedWindow ?? previewChunkWindow({
    maxPlaintextBytes: byteLimit, maxSlots: maxPrefetchSlots,
  })

  const windowForSession = (session) => fixedWindow ?? previewChunkWindow({
    plaintextChunkSize: plaintextChunkSizeFor(session?.blob ?? {}),
    maxPlaintextBytes: byteLimit,
    maxSlots: maxPrefetchSlots,
  })

  // ── slot scheduler ────────────────────────────────────────────────────────
  //
  // ★ หัวใจของ GOAL 2/4/7: คิวเดียวที่มีสองชั้นความสำคัญ foreground ได้ช่องก่อนเสมอ
  //   และงานเก็งล่วงหน้าถูกจำกัดไม่ให้ยึดครบทุกช่อง จึงมีช่องว่างสำหรับก้อนที่ผู้เล่นขอ
  //   จริงตลอดเวลา แม้ตอนที่งานเก็งกำลังวิ่งอยู่เต็มที่
  const scheduler = (token) => {
    let s = schedulers.get(token)
    if (!s) { s = { active: 0, speculative: 0, queue: [] }; schedulers.set(token, s) }
    return s
  }

  const canStart = (s, w, speculative) => {
    if (speculative) return s.active < w.maxInFlight && s.speculative < w.maxSpeculativeInFlight
    if (s.active < w.maxInFlight) return true
    // ★ ช่องสำรองของ foreground — เปิดเฉพาะตอนที่งานเก็งเป็นตัวยึดช่องอยู่จริง
    //   คำขอ foreground ล้วน ๆ หลายใบยังชนเพดาน maxInFlight ตามเดิม
    return s.speculative > 0 && s.active < (w.maxTotalInFlight ?? w.maxInFlight)
  }

  const pump = (token) => {
    const s = schedulers.get(token)
    if (!s) return
    const w = windowOf(token)
    for (;;) {
      let at = s.queue.findIndex((entry) => !entry.speculative && canStart(s, w, false))
      if (at < 0) at = s.queue.findIndex((entry) => entry.speculative && canStart(s, w, true))
      if (at < 0) return
      const [slot] = s.queue.splice(at, 1)
      slot.queued = false
      slot.running = true
      s.active += 1
      if (slot.speculative) s.speculative += 1
      slot.startedSpeculative = slot.speculative
      slot.start()
    }
  }

  const releaseSlot = (token, slot) => {
    const s = schedulers.get(token)
    if (!s || !slot.running) return
    slot.running = false
    s.active = Math.max(0, s.active - 1)
    if (slot.startedSpeculative) s.speculative = Math.max(0, s.speculative - 1)
    pump(token)
  }

  /** Move a still-queued speculative load into the foreground class. */
  const promote = (token, slot) => {
    if (!slot || !slot.queued || !slot.speculative) return false
    slot.speculative = false
    pump(token)
    return true
  }

  /** Drop queued (not yet started) speculative work; running work is left bounded. */
  const discardQueuedSpeculative = (token, keep = () => false) => {
    const s = schedulers.get(token)
    if (!s) return 0
    let dropped = 0
    for (const slot of [...s.queue]) {
      if (!slot.speculative || keep(slot.index)) continue
      const at = s.queue.indexOf(slot)
      if (at >= 0) s.queue.splice(at, 1)
      slot.queued = false
      dropped += 1
      slot.abandon()
    }
    if (dropped) {
      discardedSpeculative += dropped
      onReadAheadEvent?.('discarded', { discardedSpeculativeChunks: dropped })
      pump(token)
    }
    return dropped
  }

  /** The AbortSignal every load for this token is bound to, or null. */
  const sessionSignal = (token) => sessionAborters.get(token)?.signal ?? null

  /**
   * Make every session-owned in-flight load for this token unusable.
   * ⚠️ Called by close, closeAll and session replacement — after any of these,
   *    no late plaintext may be delivered even if bytes were already on the way.
   */
  const abortSession = (token) => {
    const aborter = sessionAborters.get(token)
    sessionAborters.delete(token)
    if (!aborter || aborter.signal?.aborted) return
    try { aborter.abort(previewSessionInvalidatedError()) } catch { /* already aborted */ }
  }

  const clearTokenCache = (token) => {
    const prefix = `${token}:`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
  }

  /**
   * ทิ้งงานอ่านล่วงหน้าทั้งหมดของ token นี้
   * ⚠️ ปิด preview / ล็อกตู้ / closeAll / เปลี่ยนเซสชัน ต้องทำให้ทั้งงาน foreground และ
   *    งานเก็งล่วงหน้าใช้การไม่ได้ทันที — ไม่มี plaintext สายไหนถูกส่งออกไปได้อีก
   */
  const dropReadAhead = (token) => {
    const s = schedulers.get(token)
    if (!s) return
    for (const slot of s.queue.splice(0)) { slot.queued = false; slot.abandon() }
    schedulers.delete(token)
  }

  const open = (token, session) => {
    bumpToken(token)
    // Replacing a session cancels the work the replaced one owned; the new
    // session starts with its own controller and shares nothing with the old.
    abortSession(token)
    dropReadAhead(token)
    clearTokenCache(token)
    sessionAborters.set(token, new AbortController())
    sessions.set(token, session)
    windows.set(token, windowForSession(session))
    // ⚠️ null ไม่ใช่ 0 — "ยังไม่รู้ตำแหน่งที่กำลังเล่น" ต่างจาก "กำลังเล่นก้อนแรก"
    //    ตราบใดที่ยังไม่มีการอ่านล่วงหน้าในเซสชันนี้ การไล่ก้อนออกจะใช้ LRU ตามเดิม
    foregrounds.set(token, null)
  }

  const close = (token) => {
    bumpToken(token)
    sessions.delete(token)
    abortSession(token)
    dropReadAhead(token)
    clearTokenCache(token)
    windows.delete(token)
    foregrounds.delete(token)
  }

  const closeAll = () => {
    globalEpoch += 1
    sessions.clear()
    for (const token of [...sessionAborters.keys()]) abortSession(token)
    sessionAborters.clear()
    for (const token of [...schedulers.keys()]) dropReadAhead(token)
    schedulers.clear()
    cache.clear()
    tokenEpochs.clear()
    windows.clear()
    foregrounds.clear()
  }

  const getOrRecover = async (token, recover) => {
    const current = sessions.get(token)
    if (current) return { ok: true, session: current, rehydrated: false }
    if (recoveries.has(token)) return recoveries.get(token)

    const startedTokenEpoch = tokenEpoch(token)
    const startedGlobalEpoch = globalEpoch
    const pending = (async () => {
      let result
      try { result = await recover(token) } catch { result = null }
      if (globalEpoch !== startedGlobalEpoch || tokenEpoch(token) !== startedTokenEpoch) {
        return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_SESSION_LOST }
      }
      if (!result?.session || result.token !== token) {
        return { ok: false, reason: PREVIEW_FAILURE_REASON.WORKER_SESSION_REHYDRATE_FAILED }
      }
      open(token, result.session)
      return { ok: true, session: result.session, rehydrated: true }
    })().finally(() => recoveries.delete(token))
    recoveries.set(token, pending)
    return pending
  }

  const tokenEntries = (token) => {
    const prefix = `${token}:`
    return [...cache.entries()].filter(([key]) => key.startsWith(prefix))
  }

  const totalBytes = () => [...cache.values()].reduce((sum, item) => sum + item.size, 0)

  /**
   * ก้อนไหนควรถูกทิ้งก่อน
   *
   * ⚠️ LRU ล้วน ๆ ทิ้งผิดก้อนสำหรับงานนี้ และทิ้งผิดแบบเงียบ ๆ ด้วย: การเล่นวิดีโอทำให้
   *    ก้อนปัจจุบันถูก "ใช้ล่าสุด" เสมอ ส่วนก้อนที่อ่านล่วงหน้าไว้ยังไม่มีใครแตะ ผลคือ
   *    N+1 กลายเป็นก้อนที่เก่าที่สุดในสายตา LRU แล้วถูกทิ้งทิ้งไปทั้งที่จะถูกใช้ในอีก
   *    ~1.5 วินาที ซึ่งทำลายประโยชน์ของการอ่านล่วงหน้าทั้งหมดโดยที่เทสต์ขนาดแคชยังผ่าน
   *
   *    เมื่อรู้ตำแหน่ง foreground แล้ว ก้อนที่ "เล่นผ่านไปแล้ว" คือก้อนที่ควรทิ้งก่อนเสมอ
   *    ถ้ายังไม่เคยมีการอ่านล่วงหน้าในเซสชันนี้ (ไม่มีตำแหน่ง foreground) ก็กลับไปใช้ LRU
   *    ตามเดิมทุกประการ
   */
  const evictionCandidate = (token, keepKey) => {
    const entries = tokenEntries(token)
    if (!entries.length) return null
    const head = foregrounds.get(token)
    const w = windowOf(token)
    const prefix = `${token}:`
    if (head !== null && head !== undefined) {
      const outside = entries.find(([key]) => key !== keepKey
        && !withinReadAheadWindow(Number(key.slice(prefix.length)), head, w.prefetchAhead))
      if (outside) return outside[0]
    }
    const oldest = entries.find(([key]) => key !== keepKey)
    return oldest ? oldest[0] : entries[0][0]
  }

  /**
   * บังคับเพดานทั้งสองชั้นหลังจากก้อนหนึ่งถอดเสร็จ
   * ⚠️ เพดานไบต์คือกติกาที่ห้ามผ่อน จำนวนช่องเป็นเพียงรูปแบบที่สะดวกของกติกาเดียวกัน
   *    ทั้งสองวงห้ามทิ้งก้อนที่เพิ่งอ่านเสร็จถ้ามันเป็นก้อนสุดท้ายที่เหลืออยู่
   */
  const enforceBudgets = (token, keepKey) => {
    const w = windowOf(token)
    while (tokenEntries(token).length > w.cacheSlots) {
      const victim = evictionCandidate(token, keepKey)
      if (victim === null) break
      cache.delete(victim)
    }
    while (totalBytes() > byteLimit) {
      let victim = evictionCandidate(token, keepKey)
      // งบไบต์เป็นเพดานรวมของ worker ทั้งตัว ถ้า token นี้ไม่มีอะไรให้ทิ้งแล้ว
      // ก็ต้องไปทิ้งของ token อื่นแทน ไม่ใช่ปล่อยให้เกินเพดาน
      if (victim === null || victim === keepKey) {
        victim = [...cache.keys()].find((key) => key !== keepKey) ?? keepKey
      }
      if (victim === keepKey && cache.size === 1) break
      if (!cache.has(victim)) break
      cache.delete(victim)
    }
  }

  /**
   * อ่านหนึ่งก้อน — ผ่านแคช/Promise ที่เซสชันเป็นเจ้าของร่วมกัน
   *
   * ★ GOAL 3: ถ้าก้อนนี้ถูกอ่านล่วงหน้าไว้อยู่แล้ว คำขอ Range จริงจะ "เกาะ Promise เดิม"
   *   ไม่มีการยิง HTTP ซ้ำ และถ้ามันยังรอคิวอยู่ มันจะถูกเลื่อนขึ้นเป็น foreground ทันที
   */
  const readChunk = async (token, index, load, { speculative = false } = {}) => {
    const activeSession = sessions.get(token)
    if (!activeSession) throw previewSessionInvalidatedError('preview session unavailable')
    const startedTokenEpoch = tokenEpoch(token)
    const startedGlobalEpoch = globalEpoch
    const key = cacheKey(token, index)

    if (cache.has(key)) {
      const existing = cache.get(key)
      cache.delete(key)
      cache.set(key, existing)
      if (!speculative && existing.speculative) {
        // ก้อนนี้เกิดจากการอ่านล่วงหน้า และตอนนี้ผู้เล่นขอมันจริง ๆ
        existing.speculative = false
        promote(token, existing.slot)
        onReadAheadEvent?.('prefetch-hit', { prefetchHits: 1 })
      }
      onCacheEvent?.('hit')
      const value = await existing.promise
      if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
        throw previewSessionInvalidatedError()
      }
      return value
    }

    onCacheEvent?.('miss')
    if (!speculative) onReadAheadEvent?.('prefetch-miss', { prefetchMisses: 1 })

    const slot = { speculative, index, queued: true, running: false, startedSpeculative: false }
    const entry = { promise: null, size: 0, speculative, slot }

    let settle
    const pending = new Promise((resolve, reject) => { settle = { resolve, reject } })

    // ⚠️ ตัว load ถูกเรียก **ตรง ๆ ตอนได้ช่อง** ไม่ผ่าน await คั่น: การเลื่อนไปอีกหนึ่ง
    //    microtask ทำให้ "คำขอที่ได้ช่องว่างทันที" กลายเป็นงานที่ยังไม่เริ่ม ซึ่งทั้งชุด
    //    ทดสอบและ Chromium สังเกตเห็นความต่างนี้ได้จริง
    slot.start = () => {
      let result
      try {
        if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
          throw previewSessionInvalidatedError()
        }
        // ★ The session's signal, not the caller's: this Promise is shared with
        //   every other Range response that wants the same chunk.
        result = Promise.resolve(load(index, { signal: sessionSignal(token) }))
      } catch (err) {
        releaseSlot(token, slot)
        settle.reject(err)
        return
      }
      result.then(
        (value) => { releaseSlot(token, slot); settle.resolve(value) },
        (err) => { releaseSlot(token, slot); settle.reject(err) },
      )
    }
    // ถูกทิ้งตั้งแต่ยังไม่ได้ช่อง: ไม่มีการยิงเครือข่ายเกิดขึ้นเลย
    slot.abandon = () => {
      if (cache.get(key) === entry) cache.delete(key)
      settle.reject(speculativeDiscardedError())
    }

    entry.promise = pending
    cache.set(key, entry)
    scheduler(token).queue.push(slot)
    pump(token)

    try {
      const value = await pending
      if (!lifecycleMatches(token, activeSession, startedTokenEpoch, startedGlobalEpoch)) {
        if (cache.get(key) === entry) cache.delete(key)
        throw previewSessionInvalidatedError()
      }
      entry.size = Math.max(0, Number(value?.byteLength) || 0)
      if (entry.size > byteLimit) {
        // ก้อนเดียวที่ใหญ่กว่างบทั้งหมด: ส่งได้ แต่ห้ามถือค้างไว้
        cache.delete(key)
      } else {
        enforceBudgets(token, key)
      }
      return value
    } catch (err) {
      if (cache.get(key) === entry) cache.delete(key)
      throw err
    }
  }

  /**
   * เริ่มงานอ่านล่วงหน้าแบบเก็ง — ไม่มีใครรอผลของมัน
   * ⚠️ ความล้มเหลวของงานเก็งต้องเงียบสนิท: มันไม่ใช่คำขอของผู้ใช้ การประกาศว่า preview
   *    พังเพราะก้อนที่ไม่มีใครขอ คือบั๊กประเภทเดียวกับที่ E3.2 เพิ่งเอาออกไป
   *    ถ้าก้อนนั้นจำเป็นจริง คำขอ foreground จะดึงมันใหม่และรายงานตามจริงเอง
   */
  const prefetch = (token, indexes, load) => {
    const started = []
    for (const index of indexes) {
      if (cache.has(cacheKey(token, index))) continue
      started.push(index)
      readChunk(token, index, load, { speculative: true }).catch(() => { /* speculative */ })
    }
    if (started.length) onReadAheadEvent?.('prefetch-start', { prefetchIndexes: started })
    return started
  }

  /**
   * ประกาศก้อน foreground ปัจจุบัน แล้วเปิดงานอ่านล่วงหน้าที่ตามหลังมัน
   *
   * ★ GOAL 4 (seek): การกระโดดจากก้อน 10 ไป 50 ทำให้งานเก็งของ 11/12/13 ที่ยังรอคิวอยู่
   *   ถูกทิ้งทันที ก้อน 50 ได้ช่องก่อน แล้วหน้าต่างใหม่จึงกลายเป็น 51/52/53
   *   งานที่ "เริ่มไปแล้ว" ปล่อยให้จบได้ (มันมีขอบเขตแน่นอนอยู่แล้ว) แต่มันยึดช่องได้
   *   ไม่ครบทุกช่อง จึงไม่มีทางกั้นก้อน 50 ไว้
   */
  const readAhead = (token, foregroundIndex, load, { chunkCount } = {}) => {
    if (!sessions.get(token)) return []
    const head = Math.floor(Number(foregroundIndex))
    if (!Number.isFinite(head)) return []
    const w = windowOf(token)
    foregrounds.set(token, head)
    discardQueuedSpeculative(token, (index) => withinReadAheadWindow(index, head, w.prefetchAhead))
    if (w.prefetchAhead <= 0) return []
    const indexes = prefetchIndexesAfter(head, { prefetchAhead: w.prefetchAhead, chunkCount })
    return prefetch(token, indexes, load)
  }

  return {
    open,
    close,
    closeAll,
    get: (token) => sessions.get(token) ?? null,
    getOrRecover,
    readChunk,
    prefetch,
    readAhead,
    sessionSignal,
    windowFor: (token) => ({ ...windowOf(token) }),
    foregroundIndex: (token) => foregrounds.get(token) ?? null,
    inFlightCount: (token) => schedulers.get(token)?.active ?? 0,
    speculativeInFlightCount: (token) => schedulers.get(token)?.speculative ?? 0,
    queuedCount: (token) => schedulers.get(token)?.queue.length ?? 0,
    discardedSpeculativeCount: () => discardedSpeculative,
    cacheSize: () => cache.size,
    cacheBytes: totalBytes,
    sessionCount: () => sessions.size,
    cachedChunkIndexes: (token) => {
      const prefix = `${token}:`
      return [...cache.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => Number(key.slice(prefix.length)))
        .sort((a, b) => a - b)
    },
  }
}
