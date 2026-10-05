// src/lib/downloadStreamSession.js — AEGIS Drive (IDEA1) · ฝั่งหน้าเว็บของการดาวน์โหลดแบบสตรีมผ่าน Service Worker
//
// ปลายทางของ ZIP สำหรับเบราว์เซอร์ที่ไม่มี File System Access แต่มี Service Worker (เช่น Brave บน Windows)
// คืน sink ที่มีหน้าตาเดียวกับ FileSystemWritableFileStream ที่ runBulkZip ใช้: write / close / abort
//
// ⚠️ ใช้ worker ตัวเดิมของ /drive/ ผ่าน ensurePreviewWorkerResult — ไม่ลงทะเบียน worker ตัวที่สอง
// ⚠️ ไม่มีอะไรออกไปที่เครือข่าย: ไบต์ไปที่ worker ต้นทางเดียวกันในเบราว์เซอร์เครื่องนี้ผ่าน MessagePort
//    แล้ว worker ส่งต่อให้ตัวจัดการดาวน์โหลดของเบราว์เซอร์ ไม่มี storage ใด ๆ ระหว่างทาง
// ⚠️ ทุกความล้มเหลว (worker หาย, เบราว์เซอร์ยกเลิก, ล็อกตู้, หมดเวลา) = write/close ถัดไปโยน
//    และ stream ฝั่ง worker จบแบบ error — การดาวน์โหลดที่ไม่ครบต้องไม่มีวันจบแบบ "สำเร็จ"
import { askWorker, ensurePreviewWorkerResult, newPreviewToken } from './vaultPreviewSession.js'
import { DOWNLOAD_STREAM_LIMITS, DOWNLOAD_STREAM_MESSAGE, downloadUrlFor } from './downloadStreamWorkerState.js'

/**
 * ตรวจจากความสามารถจริง ไม่ใช่ user agent
 * ⚠️ isSecureContext ต้องเป็น true จริง ๆ (Service Worker ลงทะเบียนได้เฉพาะ secure context)
 */
export function supportsWorkerStreamDownload(scope = globalThis) {
  if (!scope?.navigator?.serviceWorker) return false
  if (typeof scope.ReadableStream !== 'function' || typeof scope.MessageChannel !== 'function') return false
  if (scope.isSecureContext !== true) return false
  return Boolean(scope.document)
}

/**
 * ตัวกระตุ้นการดาวน์โหลด: iframe ซ่อนที่นำทางไปยัง URL เสมือน (same-origin → frame-src 'self')
 * ⚠️ ไม่ใช้ top-level navigation: ถ้า worker ไม่ได้ดักคำขอ หน้าแอป (และสถานะ Vault ที่ปลดล็อก)
 *    ต้องไม่ถูกนำทางทิ้ง — ความล้มเหลวจบอยู่ใน iframe ที่มองไม่เห็นเท่านั้น
 */
export function hiddenFrameTrigger(scope = globalThis) {
  return (url) => {
    const frame = scope.document.createElement('iframe')
    frame.hidden = true
    frame.tabIndex = -1
    frame.setAttribute('aria-hidden', 'true')
    frame.src = url
    scope.document.body.appendChild(frame)
    return () => frame.remove()
  }
}

const streamError = (reason) => Object.assign(new Error(`download stream ${reason}`), { code: 'DOWNLOAD_STREAM', reason })

/**
 * เปิดปลายทางของ archive หนึ่งใบ
 * @returns {Promise<{ ok: true, sink: { write(b: Uint8Array): Promise<void>, close(): Promise<void>, abort(): Promise<void> } }
 *                 | { ok: false, reason: 'cancelled'|'stream-unavailable' }>}
 */
export async function openWorkerStreamSink({
  filename, totalBytes, source, signal,
  scope = globalThis,
  base = import.meta.env?.BASE_URL ?? '/',
  ensureWorker = () => ensurePreviewWorkerResult({ scope }),
  trigger = hiddenFrameTrigger(scope),
  limits = DOWNLOAD_STREAM_LIMITS,
  startTimeoutMs = 15_000,
  keepaliveMs = 10_000,
  keepaliveTimeoutMs = 10_000,
  frameLingerMs = 30_000,
} = {}) {
  if (signal?.aborted) return { ok: false, reason: 'cancelled' }
  let worker
  try { worker = await ensureWorker() } catch { worker = null }
  if (signal?.aborted) return { ok: false, reason: 'cancelled' }
  if (!worker?.ok || !worker.controller?.postMessage) return { ok: false, reason: 'stream-unavailable' }
  const controller = worker.controller

  const token = newPreviewToken(scope)
  const channel = new scope.MessageChannel()
  const port = channel.port1

  let failure = null
  let finished = false
  let waiter = null       // { type, resolve, reject, timer } — โปรโตคอลมีคำตอบค้างได้ทีละหนึ่ง
  let creditWake = null   // ปลุก write ที่รอ credit
  let inflight = 0        // ไบต์ที่ส่งไปแล้วแต่ worker ยังไม่ ack
  let removeFrame = null
  let keepTimer = null
  let keepBusy = false

  const clearWaiter = () => {
    const w = waiter
    waiter = null
    if (w?.timer != null) scope.clearTimeout(w.timer)
    return w
  }
  const stopKeepalive = () => {
    if (keepTimer !== null) { scope.clearInterval(keepTimer); keepTimer = null }
  }
  const dropFrame = (delayMs) => {
    const remove = removeFrame
    removeFrame = null
    if (!remove) return
    if (delayMs > 0) scope.setTimeout(() => { try { remove() } catch { /* ถูกถอดไปแล้ว */ } }, delayMs)
    else { try { remove() } catch { /* ถูกถอดไปแล้ว */ } }
  }
  const teardown = () => {
    stopKeepalive()
    signal?.removeEventListener?.('abort', onAbort)
    port.onmessage = null
    try { port.close() } catch { /* ปิดไปแล้ว */ }
  }

  /** ทางออกเดียวของความล้มเหลว — ซ้ำได้; บอก worker ให้จบ stream แบบ error */
  const fail = (reason) => {
    if (failure || finished) return
    failure = reason
    try { port.postMessage({ type: 'abort' }) } catch { /* worker หายไปแล้ว */ }
    teardown()
    dropFrame(0)
    clearWaiter()?.reject(streamError(reason))
    const wake = creditWake
    creditWake = null
    wake?.()
  }
  const onAbort = () => fail('cancelled')

  port.onmessage = (event) => {
    const msg = event.data
    if (msg?.type === 'ack') {
      inflight = Math.max(0, inflight - (Number(msg.bytes) || 0))
      const wake = creditWake
      creditWake = null
      wake?.()
      return
    }
    if (msg?.type === 'failed') { fail(typeof msg.reason === 'string' ? msg.reason : 'worker'); return }
    if (waiter && msg?.type === waiter.type) clearWaiter().resolve()
  }

  const expect = (type, timeoutMs) => new Promise((resolve, reject) => {
    if (failure) { reject(streamError(failure)); return }
    waiter = { type, resolve, reject, timer: null }
    if (timeoutMs > 0) waiter.timer = scope.setTimeout(() => fail('timeout'), timeoutMs)
  })

  signal?.addEventListener?.('abort', onAbort, { once: true })

  /* ── เปิดเซสชัน → นำทาง → รอให้ worker รับคำขอจริง ── */
  try {
    controller.postMessage({ type: DOWNLOAD_STREAM_MESSAGE.OPEN, token, filename, totalBytes, source }, [channel.port2])
    await expect('opened', startTimeoutMs)
    removeFrame = trigger(downloadUrlFor(token, base))
    await expect('started', startTimeoutMs)
  } catch {
    fail('start')
    return { ok: false, reason: failure === 'cancelled' || signal?.aborted ? 'cancelled' : 'stream-unavailable' }
  }

  /* ── worker ที่ถูกเบราว์เซอร์ปิดทิ้งกลางทางลืมเซสชันไปหมด: keepalive ทำให้รู้ตัวและล้มแบบปิด ──
        ข้อความ keepalive ยังเป็น event ที่ต่ออายุ worker ระหว่างโอนไฟล์ยาว ๆ ด้วย */
  if (keepaliveMs > 0) {
    keepTimer = scope.setInterval(() => {
      if (keepBusy || failure || finished) return
      keepBusy = true
      Promise.resolve(askWorker(controller, { type: DOWNLOAD_STREAM_MESSAGE.KEEPALIVE, token }, { scope, timeoutMs: keepaliveTimeoutMs }))
        .then((res) => { if (!res?.ok || !res.has) fail('worker-lost') }, () => fail('worker-lost'))
        .finally(() => { keepBusy = false })
    }, keepaliveMs)
  }

  const waitForCredit = async (n) => {
    while (!failure && inflight + n > limits.windowBytes) {
      await new Promise((resolve) => { creditWake = resolve })
    }
    if (failure) throw streamError(failure)
  }

  const sink = {
    async write(bytes) {
      if (failure) throw streamError(failure)
      if (finished) throw streamError('closed')
      for (let off = 0; off < bytes.length; off += limits.maxMessageBytes) {
        const n = Math.min(limits.maxMessageBytes, bytes.length - off)
        await waitForCredit(n)
        // สำเนาของตัวเอง — ตัวเขียน ZIP อาจใช้บัฟเฟอร์เดิมซ้ำ และการ transfer จะ detach บัฟเฟอร์ที่ส่งไป
        const copy = bytes.slice(off, off + n)
        inflight += n
        port.postMessage({ type: 'chunk', bytes: copy.buffer }, [copy.buffer])
      }
      if (failure) throw streamError(failure)
    },
    async close() {
      if (failure) throw streamError(failure)
      if (finished) return
      port.postMessage({ type: 'close' })
      await expect('closed', 0)
      finished = true
      teardown()
      // การดาวน์โหลดถูกส่งต่อให้เบราว์เซอร์แล้ว — ถอด iframe ทีหลังเผื่อเบราว์เซอร์ยังอ่านคำตอบไม่จบ
      dropFrame(frameLingerMs)
    },
    async abort() {
      fail('aborted')
    },
  }
  return { ok: true, sink }
}
