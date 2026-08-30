// src/vaultPreviewServiceWorker.js — AEGIS Drive (IDEA1) · Service Worker ของ preview วิดีโอ V2
//
// ⚠️ ไฟล์นี้ตั้งใจให้ "บางที่สุดเท่าที่จะบางได้" ตรรกะทั้งหมด — การแมปช่วงไบต์ การถอดรหัส
//    การประกอบ header การหยุดเมื่อ tag ไม่ผ่าน — อยู่ใน src/lib/vaultPreviewResponder.js
//    และ src/lib/vaultPreviewRange.js ซึ่งมีชุดทดสอบตรึงไว้ ที่นี่มีแต่การต่อสาย event
//    เพราะทุกบรรทัดที่เขียนไว้ในไฟล์นี้คือบรรทัดที่ node:test เอื้อมไม่ถึง
//
// ⚠️ สิ่งที่ worker นี้ **ไม่** ทำ และต้องไม่มีใครเพิ่มเข้ามาภายหลัง:
//    - ไม่แตะ Cache API เลยแม้แต่บรรทัดเดียว (plaintext ห้ามถูกเก็บนอกหน่วยความจำ)
//    - ไม่เขียนอะไรลง IndexedDB / storage ใด ๆ
//    - ไม่ดักคำขออื่นนอกจาก path เสมือนของ preview — คำขอปกติทุกใบผ่านไปตามเดิม
//    - ไม่เก็บเซสชันข้ามการรีสตาร์ตของ worker: ถ้า worker ถูกปลุกใหม่ มันขอสำเนา
//      CryptoKey จากหน้าเว็บที่ยังปลดล็อกและยังถือ token ใบนั้นอยู่ใน memory เท่านั้น
import { previewTokenFromPath } from './lib/vaultPreviewRange.js'
import { createPreviewStream, planPreviewResponse, readPlainChunk } from './lib/vaultPreviewResponder.js'
import { createPreviewWorkerState } from './lib/vaultPreviewWorkerState.js'
import { PREVIEW_FAILURE_REASON, previewFailureGroup } from './lib/vaultPreviewErrors.js'
import { createPreviewDiagnostics, previewDiagnosticsEnabled } from './lib/vaultPreviewDiagnostics.js'
import { PREVIEW_CLAIM_MESSAGE, handlePreviewClaimRequest } from './lib/vaultPreviewClaim.js'

let diagnosticsEnabled = previewDiagnosticsEnabled(self)
const diagnostics = createPreviewDiagnostics({
  enabled: () => diagnosticsEnabled,
  emit: (record) => console.debug('[AEGIS vault preview]', record),
})
// ⚠️ LFT-V2-E3.3 — ไม่มี maxPlaintextChunks ตายตัวอีกต่อไปโดยเจตนา
//    หน้าต่างงานถูกคำนวณจาก "ขนาดก้อน plaintext ของ blob ใบนี้" เทียบกับงบ 64 MiB
//    ตอน open เซสชัน (ดู vaultPreviewReadAhead.js) ก้อน 16 MiB จึงได้ 4 ช่อง
//    (ปัจจุบัน + อ่านล่วงหน้า 3) ส่วนก้อน 64 MiB ได้ 1 ช่องและไม่อ่านล่วงหน้าเลย
//    เพดาน plaintext ที่ถือค้างไว้เท่ากันทุก profile คือ 64 MiB
const state = createPreviewWorkerState({
  onCacheEvent: (kind) => diagnostics.record('cache', kind === 'hit' ? { cacheHits: 1 } : { cacheMisses: 1 }),
  onReadAheadEvent: (kind, fields) => diagnostics.record(`read-ahead-${kind}`, fields),
})
let requestNumber = 0

const scopeBase = () => new URL('./', self.registration?.scope ?? self.location.href).pathname

self.addEventListener('install', () => {
  // เข้าควบคุมทันที ไม่ต้องรอให้ผู้ใช้ปิดแท็บทุกใบก่อน — preview ที่ต้องรีเฟรชสองรอบ
  // ก่อนจะทำงานคือ preview ที่ผู้ใช้จะรายงานว่าพัง
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const msg = event.data
  const reply = (payload) => event.ports?.[0]?.postMessage(payload)
  if (!msg || typeof msg !== 'object') return

  switch (msg.type) {
    case 'vault-preview-open':
      if (!msg.token || !msg.dek || !msg.blob?.id) { reply({ ok: false }); return }
      diagnosticsEnabled = diagnosticsEnabled || msg.diagnostics === true
      state.open(msg.token, {
        dek: msg.dek,
        blob: msg.blob,
        contentType: msg.contentType,
        plainSize: Number(msg.plainSize) || 0,
      })
      reply({ ok: true })
      return

    case 'vault-preview-close':
      // ★ ลบกุญแจออกจากหน่วยความจำของ worker — นี่คือสิ่งเดียวที่ "ปิด preview" หมายถึง
      state.close(msg.token)
      if (state.sessionCount() === 0) diagnosticsEnabled = false
      reply({ ok: true })
      return

    case 'vault-preview-close-all':
      // ใช้ตอนล็อกตู้/ล็อกอัตโนมัติ: ไม่มีเซสชันใดรอดจากการล็อก
      state.closeAll()
      diagnosticsEnabled = false
      reply({ ok: true })
      return

    case PREVIEW_CLAIM_MESSAGE:
      // The page asks once, on demand, when it sees an activated worker that is
      // not controlling it. Logic and tests live in lib/vaultPreviewClaim.js.
      handlePreviewClaimRequest({
        clients: self.clients,
        reply,
        waitUntil: (promise) => { try { event.waitUntil?.(promise) } catch { /* not extendable */ } },
      })
      return

    case 'vault-preview-status':
      reply({ ok: true, open: state.sessionCount(), has: Boolean(state.get(msg.token)) })
      return

    default:
      reply({ ok: false })
  }
})

/** บอกหน้าเว็บว่าสตรีมหยุดเพราะอะไร — UI ต้องรายงานตามจริง ไม่ใช่ค้างที่ spinner */
async function announceFailure(token, reason) {
  diagnostics.record('failure', { failureCategory: previewFailureGroup(reason) })
  const all = await self.clients.matchAll({ includeUncontrolled: false })
  for (const client of all) {
    client.postMessage({ type: 'vault-preview-failed', token, reason })
  }
}

/** Ask controlled pages once, in parallel, for the exact active token only. */
async function requestSessionFromPage(token, timeoutMs = 2_000) {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })
  if (!pages.length) return null
  return new Promise((resolve) => {
    let settled = false
    let remaining = pages.length
    const ports = []
    const finish = (value) => {
      if (settled) return
      if (value) settled = true
      remaining -= 1
      if (value || remaining <= 0) {
        settled = true
        clearTimeout(timer)
        for (const port of ports) { try { port.close() } catch { /* already closed */ } }
        resolve(value)
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      for (const port of ports) { try { port.close() } catch { /* already closed */ } }
      resolve(null)
    }, timeoutMs)

    for (const page of pages) {
      const channel = new MessageChannel()
      ports.push(channel.port1)
      channel.port1.onmessage = (event) => {
        const reply = event.data
        try { channel.port1.close() } catch { /* already closed */ }
        finish(reply?.ok && reply.token === token && reply.session
          ? { token, session: reply.session }
          : null)
      }
      // No blob id, key, filename, or metadata leaves this request. The token
      // is sufficient for the page to find its exact active in-memory entry.
      try {
        page.postMessage({ type: 'vault-preview-session-needed', token }, [channel.port2])
      } catch {
        try { channel.port1.close() } catch { /* already closed */ }
        finish(null)
      }
    }
  })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // ⚠️ ต้นทางอื่น หรือ path ที่ไม่ใช่ของ preview = ไม่ใช่ธุระของ worker นี้ ปล่อยผ่าน
  if (url.origin !== self.location.origin) return
  const token = previewTokenFromPath(url.pathname)
  if (!token) return

  event.respondWith((async () => {
    const number = ++requestNumber
    const startedAt = Date.now()
    const recovered = await state.getOrRecover(token, requestSessionFromPage)
    if (!recovered.ok) {
      await announceFailure(token, recovered.reason)
      return new Response(null, { status: 410, headers: { 'Cache-Control': 'no-store' } })
    }
    const session = recovered.session
    if (recovered.rehydrated) diagnostics.record('session-rehydrated', { rehydrationCount: 1 })

    const plan = planPreviewResponse(session, {
      method: event.request.method,
      rangeHeader: event.request.headers.get('Range'),
    })

    if (!plan.streamable) {
      if (plan.status === 416) await announceFailure(token, PREVIEW_FAILURE_REASON.RANGE_INVALID)
      return new Response(null, { status: plan.status, headers: plan.headers })
    }

    const contentRange = plan.headers['Content-Range']
    const rangeMatch = /^bytes (\d+)-(\d+)\//.exec(contentRange ?? '')
    const requestedRange = /^bytes=(\d*)-(\d*)$/i.exec(event.request.headers.get('Range') ?? '')
    diagnostics.record('range', {
      requestNumber: number,
      requestStart: requestedRange?.[1] ? Number(requestedRange[1]) : 0,
      requestEnd: requestedRange?.[2] ? Number(requestedRange[2]) : Number(session.plainSize) - 1,
      responseStart: rangeMatch ? Number(rangeMatch[1]) : 0,
      responseEnd: rangeMatch ? Number(rangeMatch[2]) : Number(session.plainSize) - 1,
      chunkIndexes: plan.plan.map((step) => step.index),
      responseDurationMs: Date.now() - startedAt,
    })

    const loaderFor = (options) => async (loadIndex, load = {}) => readPlainChunk(session, loadIndex, {
      ...options,
      signal: load.signal ?? null,
    })

    const body = createPreviewStream(session, plan.plan, {
      fetchImpl: (input, init) => fetch(input, init),
      base: scopeBase(),
      onFailure: (reason) => { announceFailure(token, reason) },
      onDiagnostic: (eventName, fields) => diagnostics.record(eventName, fields),
      // ★ Ownership boundary: the ciphertext fetch is bound to the *session's*
      //   AbortSignal supplied by the worker state, never to the signal of
      //   whichever Range response happened to trigger this load. Two Chromium
      //   ranges commonly wait on one shared chunk Promise, so cancelling one
      //   response must leave the other's bytes intact. Close, lock, closeAll
      //   and session replacement abort that shared signal instead.
      readChunk: (_session, index, options) => {
        // ★ LFT-V2-E3.3 — จุดที่ทำให้ท่อเลิกเป็น demand-driven
        //
        //   ทุกครั้งที่ผู้เล่นขอก้อนจริง (foreground) หน้าต่างอ่านล่วงหน้าจะถูกตั้งใหม่ที่
        //   ก้อนนั้นทันที: N+1..N+k เริ่มดึงขนานกันเลยโดยไม่รอให้เบราว์เซอร์ขอ
        //   และงานเก็งของหน้าต่างเดิมที่ยังไม่ได้ช่องจะถูกทิ้งไปในจังหวะเดียวกัน
        //   ⚠️ เรียกก่อน readChunk เสมอ: การตั้งหน้าต่าง *หลัง* จากรอก้อนนี้เสร็จ คือการ
        //      กลับไปเป็นแบบเดิมอย่างเงียบ ๆ เพราะงานล่วงหน้าจะเริ่มช้ากว่าที่ควรทั้งก้อน
        //   ⚠️ งานอ่านล่วงหน้าไม่มี onFailure: มันไม่ใช่คำขอของผู้ใช้ ความล้มเหลวของมัน
        //      ต้องไม่ประกาศว่า preview พัง — ก้อนที่จำเป็นจริงจะถูกขอซ้ำแบบ foreground
        //   ⚠️ owner: this stream was planned while `session` was live, and
        //      pull() is lazy. If the session was replaced in between, neither
        //      the read-ahead nor the read below may run — the loader below
        //      still closes over the replaced session's DEK and blob.
        const prefetched = state.readAhead(token, index, loaderFor(options), {
          chunkCount: session.blob?.chunkCount,
          owner: session,
        })
        diagnostics.record('read-ahead', {
          foregroundChunkIndex: index,
          prefetchIndexes: prefetched,
          inFlightLoads: state.inFlightCount(token),
          retainedPlaintextBytes: state.cacheBytes(),
          discardedSpeculativeChunks: state.discardedSpeculativeCount(),
        })
        return state.readChunk(token, index, loaderFor(options), { owner: session })
      },
    })

    return new Response(body, { status: plan.status, headers: plan.headers })
  })())
})
