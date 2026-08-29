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
//    - ไม่เก็บเซสชันข้ามการรีสตาร์ตของ worker: กุญแจอยู่ใน Map ในหน่วยความจำเท่านั้น
//      ถ้า worker ถูกปลุกใหม่ เซสชันหายไปพร้อมกัน และหน้าเว็บต้องเปิดใหม่ ซึ่งถูกต้อง
import { previewTokenFromPath } from './lib/vaultPreviewRange.js'
import { createPreviewStream, planPreviewResponse } from './lib/vaultPreviewResponder.js'

/** token → { dek, blob, contentType, plainSize } — หน่วยความจำล้วน ไม่มีที่เก็บถาวร */
const sessions = new Map()

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
      sessions.set(msg.token, {
        dek: msg.dek,
        blob: msg.blob,
        contentType: msg.contentType,
        plainSize: Number(msg.plainSize) || 0,
      })
      reply({ ok: true })
      return

    case 'vault-preview-close':
      // ★ ลบกุญแจออกจากหน่วยความจำของ worker — นี่คือสิ่งเดียวที่ "ปิด preview" หมายถึง
      sessions.delete(msg.token)
      reply({ ok: true })
      return

    case 'vault-preview-close-all':
      // ใช้ตอนล็อกตู้/ล็อกอัตโนมัติ: ไม่มีเซสชันใดรอดจากการล็อก
      sessions.clear()
      reply({ ok: true })
      return

    case 'vault-preview-status':
      reply({ ok: true, open: sessions.size, has: sessions.has(msg.token) })
      return

    default:
      reply({ ok: false })
  }
})

/** บอกหน้าเว็บว่าสตรีมหยุดเพราะอะไร — UI ต้องรายงานตามจริง ไม่ใช่ค้างที่ spinner */
async function announceFailure(token, reason) {
  const all = await self.clients.matchAll({ includeUncontrolled: false })
  for (const client of all) {
    client.postMessage({ type: 'vault-preview-failed', token, reason })
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // ⚠️ ต้นทางอื่น หรือ path ที่ไม่ใช่ของ preview = ไม่ใช่ธุระของ worker นี้ ปล่อยผ่าน
  if (url.origin !== self.location.origin) return
  const token = previewTokenFromPath(url.pathname)
  if (!token) return

  event.respondWith((async () => {
    const session = sessions.get(token)
    if (!session) {
      // เซสชันถูกปิด/ล็อกไปแล้ว — 410 บอกตรง ๆ ว่า "เคยมี ตอนนี้ไม่มีแล้ว"
      return new Response(null, { status: 410, headers: { 'Cache-Control': 'no-store' } })
    }

    const plan = planPreviewResponse(session, {
      method: event.request.method,
      rangeHeader: event.request.headers.get('Range'),
    })

    if (!plan.streamable) {
      return new Response(null, { status: plan.status, headers: plan.headers })
    }

    const body = createPreviewStream(session, plan.plan, {
      fetchImpl: (input, init) => fetch(input, init),
      base: scopeBase(),
      onFailure: (reason) => { announceFailure(token, reason) },
    })

    return new Response(body, { status: plan.status, headers: plan.headers })
  })())
})
