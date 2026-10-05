// src/lib/downloadStreamWorkerState.js — AEGIS Drive (IDEA1) · ฝั่ง Service Worker ของการดาวน์โหลดแบบสตรีม
//
// เส้นทางนี้มีไว้ให้เบราว์เซอร์ที่ "ไม่มี" File System Access (เช่น Brave บน Windows: secure context
// แต่ไม่มี window.showSaveFilePicker) ดาวน์โหลด ZIP หลายไฟล์ขนาดใหญ่เป็นไฟล์เดียวได้ โดยไม่บัฟเฟอร์
// archive ทั้งก้อนใน RAM:
//   หน้าเว็บเปิดเซสชัน (token จาก CSPRNG + MessagePort) → iframe ซ่อนนำทางไปที่
//   <scope>__aegis-download/<token> → worker ตัวเดิมของ /drive/ ตอบด้วย ReadableStream
//   → ไบต์จากตัวเขียน ZIP ถูกส่งผ่าน port ทีละก้อน พร้อม backpressure แบบ credit
//
// ⚠️ โมดูลนี้ใช้ worker ตัวเดิม (vault-preview-sw.js) — ห้ามลงทะเบียน worker ตัวที่สองบน /drive/
// ⚠️ plaintext อยู่ในหน่วยความจำเท่านั้น: ไม่มี Cache API ไม่มี IndexedDB ไม่มี storage ใด ๆ
//    เซสชันถูกลบทันทีเมื่อ close / abort / ล้มเหลว / หมดอายุ และ URL ใช้ได้ครั้งเดียว
// ⚠️ ขอบเขตหน่วยความจำ: worker ตอบ "ack" เฉพาะเมื่อคิวของ stream ยังต่ำกว่า highWaterBytes
//    หน้าเว็บมีไบต์ที่ยังไม่ได้ ack ค้างได้ไม่เกิน windowBytes — คิวใน worker จึงไม่เกิน
//    highWaterBytes + windowBytes เสมอ ผู้ส่งที่ไม่เคารพ credit ถูกตัดทันที (protocol)
// ⚠️ ตรรกะทั้งหมดอยู่ที่นี่เพื่อให้ node:test ทดสอบได้จริง — ตัว worker เป็นแค่การต่อสาย event

const MiB = 1024 * 1024

/** ส่วนของ path ที่ worker ดักไว้ — ไม่ใช่ endpoint จริงบนเซิร์ฟเวอร์ */
export const DOWNLOAD_PATH_SEGMENT = '__aegis-download'

export const DOWNLOAD_STREAM_MESSAGE = Object.freeze({
  OPEN: 'aegis-download-open',
  KEEPALIVE: 'aegis-download-keepalive',
})

export const DOWNLOAD_STREAM_LIMITS = Object.freeze({
  highWaterBytes: 4 * MiB,  // คิวของ ReadableStream ใน worker ก่อนหยุด ack
  windowBytes: 2 * MiB,     // ไบต์ที่หน้าเว็บส่งไปแล้วแต่ยังไม่ได้ ack
  maxMessageBytes: 1 * MiB, // ขนาดสูงสุดของ chunk หนึ่งข้อความ (หน้าเว็บหั่นก่อนส่ง)
  maxSessions: 4,
  pendingTtlMs: 60_000,     // เซสชันที่เปิดแล้วแต่ไม่มีการนำทางมารับ — หมดอายุ
})

const TOKEN_RE = /^[0-9a-f]{32}$/
const SOURCES = new Set(['files', 'vault'])

/** URL เสมือนของการดาวน์โหลดหนึ่งครั้ง — base คือ scope ของ worker (เช่น '/drive/') */
export function downloadUrlFor(token, base = '/') {
  return `${base}${DOWNLOAD_PATH_SEGMENT}/${token}`
}

/**
 * token จาก path — คืน null ถ้าไม่ใช่ "<scopePath>__aegis-download/<32 hex>" แบบตรงตัว
 * ⚠️ ตรงตัวเท่านั้น: ไม่รับ path ที่ลึกกว่า ไม่รับตัวพิมพ์ใหญ่ ไม่รับ segment ที่อยู่ใต้ path อื่น
 */
export function downloadTokenFromPath(pathname, scopePath) {
  if (typeof pathname !== 'string' || typeof scopePath !== 'string') return null
  const prefix = `${scopePath}${DOWNLOAD_PATH_SEGMENT}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  return TOKEN_RE.test(rest) ? rest : null
}

/**
 * Content-Disposition แบบ attachment ที่ปลอดภัย: ตัด control/quote/backslash/path separator
 * ชื่อ ASCII สำหรับเบราว์เซอร์เก่า + filename* (RFC 5987) สำหรับชื่อเต็ม
 */
export function attachmentDisposition(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f"\\/:*?<>|;]/g, '_').trim().slice(0, 180) || 'download.zip'
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(clean).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const notFound = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })

/**
 * สถานะของ worker: Map ในหน่วยความจำ — worker ถูกปลุกใหม่ = ทุกเซสชันหายไป (fail closed)
 */
export function createDownloadStreamWorkerState({ limits = DOWNLOAD_STREAM_LIMITS, timers = globalThis } = {}) {
  const sessions = new Map()

  const post = (session, payload) => { try { session.port.postMessage(payload) } catch { /* port ปิดแล้ว */ } }

  /** ทางออกเดียวของทุกการจบเซสชัน — ซ้ำได้ ไม่โยน */
  function end(session, reason, { error = true, notify = false } = {}) {
    if (session.ended) return
    session.ended = true
    if (session.expiry !== null) { timers.clearTimeout(session.expiry); session.expiry = null }
    if (sessions.get(session.token) === session) sessions.delete(session.token)
    if (error && session.controller) {
      try { session.controller.error(new Error(`download ${reason}`)) } catch { /* stream จบไปแล้ว */ }
    }
    if (notify) post(session, { type: 'failed', reason })
    session.port.onmessage = null
    try { session.port.close() } catch { /* ปิดไปแล้ว */ }
  }

  const queuedBytesOf = (session) => (session.controller ? limits.highWaterBytes - (session.controller.desiredSize ?? 0) : 0)

  function pumpAcks(session) {
    if (session.ended || session.unacked === 0 || !session.controller) return
    if ((session.controller.desiredSize ?? 0) <= 0) return
    const bytes = session.unacked
    session.unacked = 0
    post(session, { type: 'ack', bytes })
  }

  function onChunk(session, bytes) {
    if (session.phase !== 'streaming') { end(session, 'protocol', { notify: true }); return }
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > limits.maxMessageBytes) {
      end(session, 'protocol', { notify: true })
      return
    }
    const n = bytes.byteLength
    // ผู้ส่งที่ไม่รอ credit จะดันคิวเกินขอบเขตนี้ — ตัดทิ้ง ไม่ใช่ปล่อยให้ worker บวม
    if (queuedBytesOf(session) + n > limits.highWaterBytes + limits.windowBytes) {
      end(session, 'protocol', { notify: true })
      return
    }
    if (session.enqueued + n > session.totalBytes) { end(session, 'overlong', { notify: true }); return }
    try {
      session.controller.enqueue(new Uint8Array(bytes))
    } catch {
      end(session, 'consumer-gone', { notify: true })
      return
    }
    session.enqueued += n
    session.unacked += n
    pumpAcks(session)
  }

  function onClose(session) {
    if (session.phase !== 'streaming') { end(session, 'protocol', { notify: true }); return }
    // ⚠️ ปิดก่อนครบความยาวที่ประกาศ = ไฟล์ไม่ครบ ต้องจบแบบ error ไม่ใช่จบสวย ๆ
    if (session.enqueued !== session.totalBytes) { end(session, 'length-mismatch', { notify: true }); return }
    try { session.controller.close() } catch { end(session, 'consumer-gone', { notify: true }); return }
    post(session, { type: 'closed' })
    end(session, 'closed', { error: false })
  }

  function onPortMessage(session, msg) {
    if (session.ended) return
    switch (msg?.type) {
      case 'chunk': onChunk(session, msg.bytes); return
      case 'close': onClose(session); return
      case 'abort': end(session, 'aborted'); return
      default: end(session, 'protocol', { notify: true })
    }
  }

  function open({ token, filename, totalBytes, source, port } = {}) {
    if (!port?.postMessage) return false
    const refuse = (reason) => {
      try { port.postMessage({ type: 'failed', reason }) } catch { /* ไม่มีใครฟัง */ }
      try { port.close() } catch { /* ปิดไปแล้ว */ }
      return false
    }
    if (typeof token !== 'string' || !TOKEN_RE.test(token) || sessions.has(token)) return refuse('bad-request')
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || !SOURCES.has(source)) return refuse('bad-request')
    if (sessions.size >= limits.maxSessions) return refuse('busy')
    const session = {
      token, filename: String(filename ?? ''), totalBytes, source, port,
      phase: 'pending', controller: null, enqueued: 0, unacked: 0, ended: false, expiry: null,
    }
    session.expiry = timers.setTimeout(() => { session.expiry = null; end(session, 'expired', { notify: true }) }, limits.pendingTtlMs)
    port.onmessage = (event) => onPortMessage(session, event.data)
    sessions.set(token, session)
    post(session, { type: 'opened' })
    return true
  }

  /** คำตอบของการนำทางครั้งเดียวไปยัง URL เสมือน — null ถ้าไม่มีเซสชันที่รอรับอยู่ */
  function respond(token, { method = 'GET' } = {}) {
    const session = sessions.get(token)
    if (!session || session.phase !== 'pending' || method !== 'GET') return null
    session.phase = 'streaming'
    if (session.expiry !== null) { timers.clearTimeout(session.expiry); session.expiry = null }
    const body = new ReadableStream({
      start(controller) { session.controller = controller },
      pull() { pumpAcks(session) },
      // ผู้ใช้ยกเลิกในแถบดาวน์โหลด / เบราว์เซอร์ทิ้งคำตอบ — หน้าเว็บต้องรู้ ไม่ใช่เขียนต่อไปเงียบ ๆ
      cancel() { end(session, 'consumer-cancelled', { error: false, notify: true }) },
    }, { highWaterMark: limits.highWaterBytes, size: (chunk) => chunk.byteLength })
    post(session, { type: 'started' })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': attachmentDisposition(session.filename),
        'Content-Length': String(session.totalBytes),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  /** ล็อกตู้ = ทุกการดาวน์โหลดของ Vault จบแบบ error ทันที; ไม่ระบุ source = ทุกเซสชัน */
  function closeAll({ source } = {}) {
    for (const session of [...sessions.values()]) {
      if (!source || session.source === source) end(session, 'locked', { notify: true })
    }
  }

  return {
    open,
    respond,
    closeAll,
    has: (token) => sessions.has(token),
    sessionCount: () => sessions.size,
    /** ไบต์ที่ค้างในคิวของ stream ตอนนี้ — มีไว้ให้ชุดทดสอบพิสูจน์ขอบเขตหน่วยความจำ */
    queuedBytes: (token) => { const s = sessions.get(token); return s ? queuedBytesOf(s) : 0 },
  }
}

/**
 * ตัวจัดการ message ของ worker สำหรับโปรโตคอลนี้ — คืน false ถ้าไม่ใช่ข้อความของมัน
 * OPEN: ports[0] คือ port ข้อมูลของเซสชัน (คำตอบ 'opened'/'failed' ไปทาง port นั้น)
 */
export function handleDownloadStreamMessage(state, msg, ports, reply) {
  if (!msg || typeof msg !== 'object') return false
  if (msg.type === DOWNLOAD_STREAM_MESSAGE.OPEN) {
    state.open({ token: msg.token, filename: msg.filename, totalBytes: msg.totalBytes, source: msg.source, port: ports?.[0] })
    return true
  }
  if (msg.type === DOWNLOAD_STREAM_MESSAGE.KEEPALIVE) {
    reply?.({ ok: true, has: typeof msg.token === 'string' && state.has(msg.token) })
    return true
  }
  return false
}

/**
 * ตัวจัดการ fetch ของ worker: null = ไม่ใช่ธุระของโปรโตคอลนี้ (ปล่อยผ่านไปตามเดิม)
 * ⚠️ path ที่อยู่ใน namespace แต่ไม่มีเซสชัน (ใช้ซ้ำ / worker ถูกปลุกใหม่) ตอบ 404 no-store
 *    ไม่ส่งต่อไปเซิร์ฟเวอร์ — เซิร์ฟเวอร์ไม่มี endpoint นี้ และหน้าเว็บจะรายงานล้มเหลวเอง
 */
export function handleDownloadStreamFetch(state, request, { origin, scopePath }) {
  let url
  try { url = new URL(request.url) } catch { return null }
  if (url.origin !== origin) return null
  const token = downloadTokenFromPath(url.pathname, scopePath)
  if (!token) return null
  return state.respond(token, { method: request.method }) ?? notFound()
}
