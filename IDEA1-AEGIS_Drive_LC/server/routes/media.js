// server/routes/media.js — AEGIS Drive (IDEA1) · media derivative routes (poster / motion proxy / media-info / admin cache)
//
// ⚠️ ด่านความปลอดภัย (spec §14, §17) เหมือน GET /api/files/:id/preview ทุกประการและมาก่อนทุกอย่าง:
//    requireAuth → แถวไม่มี / ownerId ไม่ตรง (Admin ไม่ override) / vault → 404 + audit FILE_PREVIEW DENIED (object-hiding)
//    → โฟลเดอร์ 400 → จากนั้นค่อยถาม service; vault ไม่มีวันถึง service (ตรวจที่นี่และใน service ซ้ำอีกชั้น)
// ⚠️ URL ของ derivative ต้องระบุตัวตนครบ: v=<sha256 ปัจจุบันของแถว> และ p=<profile ปัจจุบัน> — ผิดตัวใดตัวหนึ่ง = 404
//    (ไม่มีวันเสิร์ฟ derivative ของเนื้อหา/profile เก่า), ขาด/ผิดรูป = 400; จึงยอมให้เบราว์เซอร์ cache แบบ immutable ได้
// ⚠️ cache policy: 200/304 = private, max-age=31536000, immutable + Vary: Cookie (ผูกกับ session lifecycle ที่พิสูจน์แล้ว —
//    regenerate ตอน login, destroy+clear ตอน logout) หรือ MEDIA_CACHE_POLICY=revalidate = private, max-age=0, must-revalidate;
//    ทุกคำตอบที่ไม่ใช่ 200/304 = no-store. ไม่มี route ที่รับ hash เปล่า ๆ — ทุกอย่างผูกกับ /files/:id ของเจ้าของ
// ⚠️ ไม่ audit การอ่านที่สำเร็จ (กริดหนึ่งหน้า = หลายสิบคำขอ) — เหมือน preview route; DENIED และการ invalidate ของ Admin audit เสมอ

import fs from 'node:fs'
import { Router } from 'express'
import * as store from '../db/store.js'
import { recordAudit, sha256Hex } from '../db/connection.js'
import { requestSourceIp } from '../request/sourceIp.js'
import { requireAuth, requireRole } from '../middleware/requireRole.js'
import { ROLES } from '../rbac/permissions.js'
import { parseByteRange } from '../request/byteRange.js'
import { PRIORITY } from '../media/queue.js'

export const mediaRouter = Router()
const SHA256_RE = /^[0-9a-f]{64}$/
const PROFILE_RE = /^v\d+$/
const BATCH_MAX_IDS = 64
const TYPE_BY_ROUTE = Object.freeze({ poster: 'poster', 'motion-preview': 'motion' })
const FILE_BY_TYPE = Object.freeze({ poster: 'poster', motion: 'motion.mp4' })

const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(target) : null, result, sourceIp: requestSourceIp(req),
  })

const noStore = (res) => res.setHeader('Cache-Control', 'private, no-store')
// ⚠️ ตั้ง no-store ก่อน requireAuth เสมอ — 401/403 จาก middleware ก็ต้องไม่ถูก cache; คำตอบ ready เขียนทับทีหลัง
const noStoreFirst = (req, res, next) => { noStore(res); next() }

/**
 * ด่านเจ้าของ (แบบเดียวกับ /preview): คืน { file } หรือส่งคำตอบไปแล้ว (คืน null)
 * ⚠️ ลำดับ: ไม่มี → 404; เจ้าของไม่ตรง → 404 + DENIED; vault → 404 + DENIED; โฟลเดอร์ → 400
 */
async function ownedFileOr404(req, res, id) {
  const file = await store.findFile(id)
  if (!file) { noStore(res); res.status(404).json({ error: 'Not found' }); return null }
  if (file.ownerId == null || String(file.ownerId) !== String(req.user.id)) {
    await auditAct(req, 'FILE_PREVIEW', file.name, 'DENIED')
    noStore(res); res.status(404).json({ error: 'Not found' }); return null
  }
  if (file.vault) {
    await auditAct(req, 'FILE_PREVIEW', file.name, 'DENIED')
    noStore(res); res.status(404).json({ error: 'Not found' }); return null
  }
  if (file.kind === 'folder' || file.type === 'Folder') { noStore(res); res.status(400).json({ error: 'Not a file' }); return null }
  return file
}

/** header ชุดคงที่ของ derivative ที่พร้อมเสิร์ฟ (spec §14.3, §14.6, §17.5) */
export function derivativeHeaders({ etag, mime, policy, type }) {
  const headers = {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${type === 'motion' ? 'motion.mp4' : (mime === 'image/png' ? 'poster.png' : 'poster.webp')}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  }
  if (policy === 'revalidate') headers['Cache-Control'] = 'private, max-age=0, must-revalidate'
  else { headers['Cache-Control'] = 'private, max-age=31536000, immutable'; headers.Vary = 'Cookie' }
  return headers
}

function sendDerivative(req, res, result, type, limits) {
  const headers = derivativeHeaders({ etag: result.etag, mime: result.mime, policy: limits.cachePolicy, type })
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  if (req.headers['if-none-match'] && req.headers['if-none-match'].split(',').map((s) => s.trim()).includes(result.etag)) {
    return res.status(304).end()
  }
  const size = result.bytes
  const range = parseByteRange(req.headers.range, size)
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`)
    return res.status(416).end()
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  if (range) { res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`) }
  res.setHeader('Content-Length', String(size === 0 ? 0 : end - start + 1))
  if (size === 0) return res.end()
  const stream = fs.createReadStream(result.path, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** map ServeResult → HTTP (spec §14.3) — ทุกอย่างที่ไม่ใช่ ready เป็น no-store */
function sendServeResult(req, res, result, type, limits) {
  switch (result.kind) {
    case 'ready': return sendDerivative(req, res, result, type, limits)
    case 'pending': noStore(res); res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 2)); return res.status(202).end()
    case 'retryable': noStore(res); res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 15)); return res.status(503).json({ error: 'Derivative temporarily unavailable', code: result.reason ?? 'RETRYABLE' })
    case 'failed': noStore(res); return res.status(422).json({ error: 'Derivative generation failed', code: result.reason ?? 'GENERATION_FAILED' })
    case 'unsupported': noStore(res); return res.status(415).json({ error: 'Derivative not available for this type', code: result.reason ?? 'UNSUPPORTED' })
    case 'disabled': noStore(res); return res.status(415).json({ error: 'Media derivatives are disabled', code: 'MEDIA_DISABLED' })
    case 'stale': noStore(res); return res.status(404).json({ error: 'Not found' })
    default: noStore(res); return res.status(400).json({ error: 'Bad request' })
  }
}

/* ── media-info ──────────────────────────────────────────────────────────── */
mediaRouter.get('/files/:id/media-info', noStoreFirst, requireAuth, async (req, res, next) => {
  try {
    const file = await ownedFileOr404(req, res, req.params.id)
    if (!file) return
    noStore(res)
    res.json(await req.app.get('mediaService').info(file, PRIORITY.INTERACTIVE))
  } catch (err) { next(err) }
})

mediaRouter.post('/files/media-info/batch', noStoreFirst, requireAuth, async (req, res, next) => {
  try {
    const ids = req.body?.ids
    noStore(res)
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > BATCH_MAX_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
      return res.status(400).json({ error: `ids must be 1..${BATCH_MAX_IDS} strings` })
    }
    const items = {}
    const owned = []
    for (const id of new Set(ids)) {
      const file = await store.findFile(id)
      if (!file) { items[id] = { status: 'NOT_FOUND' }; continue }
      if (file.ownerId == null || String(file.ownerId) !== String(req.user.id) || file.vault) {
        await auditAct(req, 'FILE_PREVIEW', file.name, 'DENIED')
        items[id] = { status: 'NOT_FOUND' }; continue
      }
      if (file.kind === 'folder' || file.type === 'Folder') { items[id] = { status: 'NOT_FOUND' }; continue }
      owned.push(file)
    }
    if (owned.length) {
      const map = await req.app.get('mediaService').infoBatch(owned, PRIORITY.INTERACTIVE)
      for (const file of owned) items[String(file.id)] = map.get(String(file.id)) ?? { status: 'NOT_FOUND' }
    }
    res.json({ items })
  } catch (err) { next(err) }
})

/* ── binary derivatives ─────────────────────────────────────────────────── */
for (const [segment, type] of Object.entries(TYPE_BY_ROUTE)) {
  mediaRouter.get(`/files/:id/${segment}`, noStoreFirst, requireAuth, async (req, res, next) => {
    try {
      const file = await ownedFileOr404(req, res, req.params.id)
      if (!file) return
      const limits = req.app.get('mediaLimits')
      const v = typeof req.query.v === 'string' ? req.query.v : ''
      const p = typeof req.query.p === 'string' ? req.query.p : ''
      // ⚠️ ตรวจตัวตนก่อนถาม service: ขาด/ผิดรูป = 400; sha เก่า หรือ profile ที่ไม่ใช่ปัจจุบัน = 404 (ไม่มีวันเสิร์ฟของเก่า)
      if (!SHA256_RE.test(v) || !PROFILE_RE.test(p)) { noStore(res); return res.status(400).json({ error: 'v and p are required' }) }
      if (v !== String(file.sha256 ?? '') || p !== limits.profile) { noStore(res); return res.status(404).json({ error: 'Not found' }) }
      const result = await req.app.get('mediaService').serve(file, type, { v, p })
      return sendServeResult(req, res, result, type, limits)
    } catch (err) { next(err) }
  })
}

/* ── admin ──────────────────────────────────────────────────────────────── */
mediaRouter.get('/admin/media-cache/status', noStoreFirst, requireAuth, requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    noStore(res)
    res.json(await req.app.get('mediaService').adminStatus())
  } catch (err) { next(err) }
})

mediaRouter.delete('/admin/media-cache/entries/:sha256', noStoreFirst, requireAuth, requireRole(ROLES.ADMIN), async (req, res, next) => {
  try {
    noStore(res)
    const sha = String(req.params.sha256)
    if (!SHA256_RE.test(sha)) return res.status(400).json({ error: 'sha256 must be 64 lowercase hex characters' })
    const removed = await req.app.get('mediaService').invalidate(sha, { actor: req.user.username })
    await auditAct(req, 'MEDIA_CACHE_INVALIDATE', sha, removed ? 'OK' : 'DENIED')
    res.status(204).end()
  } catch (err) { next(err) }
})

/**
 * Hook หลังคำตอบสำเร็จของ upload/commit/restore (Task 10): เรียก scheduleForFile "ครั้งเดียว" หลัง response ปิด
 * ⚠️ ไม่มี await ก่อนตอบ ไม่มีการเปลี่ยนสถานะคำตอบ ความล้มเหลวของการจัดคิวถูก log เท่านั้น
 */
export function scheduleDerivativesAfterResponse(req, res, row) {
  res.once('finish', () => {
    const service = req.app.get('mediaService')
    Promise.resolve()
      .then(() => service.scheduleForFile(row, PRIORITY.UPLOAD))
      .catch((err) => console.error('[media] schedule after upload failed:', err?.message ?? err))
  })
}

export { FILE_BY_TYPE }
