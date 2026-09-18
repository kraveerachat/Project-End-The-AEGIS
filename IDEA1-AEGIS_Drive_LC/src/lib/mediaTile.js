// src/lib/mediaTile.js — AEGIS Drive (IDEA1) · state machine ล้วน ๆ ของ media tile หนึ่งใบ (spec §15, plan Task 11)
//
// ⚠️ ตัวตนของสื่อ = contentId (sha256 ของเนื้อหา) ไม่ใช่ชื่อไฟล์: เปลี่ยนชื่อ = state เดิม; แทนที่/กู้เวอร์ชัน = reset
// ⚠️ poster ไม่มีวันหายเพราะ motion: เมื่อ 'shown' แล้ว มีแค่ CONTENT_CHANGED (sha ใหม่) ที่ย้ายมันออก (TS-3)
// ⚠️ first-hover race (Round 10): hover เป็น "สถานะ" ไม่ใช่ "เหตุการณ์" — เมื่อ proxy พร้อมทีหลังขณะ pointer ยังอยู่
//    shouldPlay กลายเป็น true เอง ไม่ต้อง leave/enter ใหม่ (TS-5) และ reducedMotion ปิดการเล่นอัตโนมัติเสมอ (TS-8)
// ⚠️ ไม่มี URL ใดถูกประกอบที่นี่: posterSrc/motionSrc คือสิ่งที่ media-info ให้มา (ทึบ) หรือ null

export const TILE_DATA_VOCAB = Object.freeze({
  poster: Object.freeze(['icon', 'loading', 'shown']),
  motion: Object.freeze(['none', 'prefetching', 'ready', 'playing', 'failed']),
  info: Object.freeze(['unknown', 'loading', 'ready', 'pending', 'unsupported', 'failed']),
})
const VIDEO_FAMILIES = new Set(['mp4', 'webm', 'mov', 'mkv'])
export const PENDING_POLL_CAP_MS = 15_000
export const PENDING_MAX_MS = 120_000
const ANIMATED_ONLY_FAMILIES = new Set(['gif'])

/** @param {{ contentId: string|null, family: string|null }} o */
export function initialTileState({ contentId = null, family = null, band = 'off', hover = false, reducedMotion = false } = {}) {
  return Object.freeze({
    contentId, family: family ? String(family).toLowerCase() : null,
    // ไม่มีตัวตนของเนื้อหา (Vault/โฟลเดอร์/ชนิดที่ไม่ preview/ไม่มี sha) = ไม่รองรับตั้งแต่ต้น ไม่ต้องถามเซิร์ฟเวอร์
    info: contentId ? 'unknown' : 'unsupported', reason: contentId ? null : 'NO_CONTENT_IDENTITY', nextInfoAt: null, animated: null, pollCount: 0, pendingSince: null, tick: 0,
    poster: 'none', posterSrc: null,
    motion: 'none', motionSrc: null, motionAvailability: 'unknown', // unknown | pending | available | unsupported | failed
    hover, band, reducedMotion,
  })
}

const next = (s, patch) => Object.freeze({ ...s, ...patch })

function applyInfo(s, info, now) {
  const at = Number.isFinite(now) ? now : 0
  if (!info || typeof info !== 'object') return next(s, { info: 'failed', reason: 'malformed' })
  if (info.status === 'NOT_FOUND') return next(s, { info: 'failed', reason: 'NOT_FOUND' })
  if (info.status === 'FAILED') return next(s, { info: 'failed', reason: info.reason ?? 'FAILED' })
  if (info.status === 'CANCELLED') return next(s, { info: s.info === 'loading' ? 'unknown' : s.info })
  const patch = { animated: typeof info.animated === 'boolean' ? info.animated : s.animated, reason: info.reason ?? null }
  // poster: URL ใหม่ (ทึบ) จากเซิร์ฟเวอร์ — ถ้าแสดงอยู่แล้วและ URL เดิม ไม่ยุ่ง; ถ้าแสดงอยู่แล้วแต่ URL เปลี่ยน (โปรไฟล์ใหม่) ก็ยังคง shown
  const posterUrl = info.poster?.state === 'READY' && typeof info.poster.url === 'string' ? info.poster.url : null
  if (posterUrl && s.poster !== 'shown') { patch.poster = 'loading'; patch.posterSrc = posterUrl }
  else if (posterUrl && s.poster === 'shown' && !s.posterSrc) { patch.posterSrc = posterUrl }
  // motion: availability แยกจากสถานะการโหลด — 'available' เมื่อ URL มา; UNSUPPORTED = ไม่มีวันมี (poster-only)
  const m = info.motion
  if (m?.state === 'READY' && typeof m.url === 'string') {
    patch.motionAvailability = 'available'
    if (s.motion === 'none') patch.motionSrc = m.url
    else if (s.motionSrc !== m.url && s.motion !== 'failed') { patch.motionSrc = m.url; patch.motion = 'none' } // URL ใหม่ (โปรไฟล์ใหม่) = โหลดใหม่
  } else if (m?.state === 'UNSUPPORTED' || m?.state === 'GENERATION_FAILED') {
    patch.motionAvailability = 'unsupported'
  } else if (m?.state === 'PENDING' || m?.state === 'RETRYABLE') {
    patch.motionAvailability = 'pending'
  }
  switch (info.status) {
    case 'READY': patch.info = 'ready'; patch.nextInfoAt = null; break
    case 'PARTIAL': patch.info = 'ready'; patch.nextInfoAt = null; break
    case 'PENDING':
    case 'RETRYABLE': {
      // ขอบเขตการ poll: เชื่อ retryAfterMs ของเซิร์ฟเวอร์ แต่ไม่ต่ำกว่า backoff ทวีคูณ (1 s → 15 s) และหยุดหลัง PENDING_MAX_MS (ดู wantsInfo)
      const hint = Number.isFinite(info.retryAfterMs) && info.retryAfterMs > 0 ? info.retryAfterMs : (Number.isFinite(info.poster?.retryAfterMs) ? info.poster.retryAfterMs : 2000)
      const pollCount = s.info === 'pending' ? s.pollCount + 1 : 0
      const wait = Math.max(hint, Math.min(PENDING_POLL_CAP_MS, 1000 * 2 ** pollCount))
      patch.info = 'pending'; patch.nextInfoAt = at + wait; patch.pollCount = pollCount; patch.pendingSince = s.info === 'pending' && s.pendingSince != null ? s.pendingSince : at
      break
    }
    case 'UNSUPPORTED': patch.info = 'unsupported'; patch.nextInfoAt = null; patch.motionAvailability = 'unsupported'; break
    case 'GENERATION_FAILED': patch.info = 'failed'; patch.nextInfoAt = null; if (!posterUrl) patch.motionAvailability = 'unsupported'; break
    default: patch.info = 'failed'; patch.reason = 'malformed'
  }
  return next(s, patch)
}

/**
 * @param {object} s
 * @param {{ type: string }} e
 */
export function tileReducer(s, e) {
  switch (e.type) {
    case 'CONTENT_CHANGED': {
      if (e.contentId === s.contentId) return s // เปลี่ยนชื่อ/ย้าย = ตัวตนเดิม = ไม่ทำอะไร
      return initialTileState({ contentId: e.contentId ?? null, family: e.family ?? s.family, band: s.band, hover: s.hover, reducedMotion: s.reducedMotion })
    }
    case 'VISIBILITY': return s.band === e.band ? s : next(s, { band: e.band })
    case 'REDUCED_MOTION': return s.reducedMotion === Boolean(e.value) ? s : next(s, { reducedMotion: Boolean(e.value) })
    case 'HOVER_ENTER': {
      // ชี้ที่ไทล์ที่หยุด poll ไปแล้ว = เริ่มรอบใหม่ "หนึ่งครั้ง" (ไม่ใช่ปลดขอบเขต)
      const stalled = s.info === 'pending' && s.pendingSince != null && Number.isFinite(e.now) && e.now - s.pendingSince >= PENDING_MAX_MS
      if (stalled) return next(s, { hover: true, pendingSince: e.now, pollCount: 0, nextInfoAt: e.now })
      return s.hover ? s : next(s, { hover: true })
    }
    case 'INFO_TICK': return s.info === 'pending' ? next(s, { tick: e.now ?? s.tick + 1 }) : s
    case 'HOVER_LEAVE': return s.hover ? next(s, { hover: false }) : s
    case 'INFO_REQUESTED': return next(s, { info: 'loading' })
    case 'INFO_LOADED': return applyInfo(s, e.info, e.now)
    case 'INFO_FAILED': return next(s, { info: 'failed', reason: e.reason ?? 'network', nextInfoAt: null })
    case 'INFO_RETRY': return s.info === 'failed' || s.info === 'pending' ? next(s, { info: 'unknown', nextInfoAt: null }) : s
    case 'POSTER_LOADED': return s.posterSrc ? next(s, { poster: 'shown' }) : s
    case 'POSTER_ERROR': return s.poster === 'shown' ? s : next(s, { poster: 'none', posterSrc: null, motionAvailability: s.motionAvailability })
    case 'MOTION_REQUESTED': return s.motionSrc && (s.motion === 'none') ? next(s, { motion: 'prefetching' }) : s
    case 'MOTION_READY': return s.motion === 'prefetching' || s.motion === 'none' ? (s.motionSrc ? next(s, { motion: 'ready' }) : s) : s
    case 'MOTION_ERROR':
    case 'PLAY_REJECTED': return next(s, { motion: 'failed', motionAvailability: 'failed' })
    default: return s
  }
}

const bandOn = (s) => s.band === 'visible' || s.band === 'near'
const motionPossible = (s) => s.motionAvailability === 'available' && s.motionSrc && s.motion !== 'failed' && !s.reducedMotion
const isVideo = (s) => VIDEO_FAMILIES.has(s.family ?? '')

export const selectors = Object.freeze({
  /** ควรขอ media-info ตอนนี้ไหม (ต้องอยู่ในแถบที่มองเห็น/ใกล้ และไม่ใช่สถานะที่จำแล้วว่าไม่มีประโยชน์) */
  wantsInfo: (s, now = 0) => {
    if (!s.contentId || !bandOn(s)) return false
    if (s.info === 'unknown') return true
    if (s.info === 'pending') {
      if (s.pendingSince != null && now - s.pendingSince >= PENDING_MAX_MS) return false // หยุดหลังเพดาน — hover ปลุกได้หนึ่งรอบ
      return s.nextInfoAt != null && now >= s.nextInfoAt
    }
    return false
  },
  wantsMotionPrefetch: (s) => Boolean(motionPossible(s) && s.motion === 'none' && (bandOn(s) || s.hover)),
  /** ชี้อยู่และยังไม่มี proxy → ขอทันทีด้วยลำดับความสำคัญสูงสุด */
  hoverPromote: (s) => Boolean(s.hover && motionPossible(s) && (s.motion === 'none' || s.motion === 'prefetching')),
  shouldPlay: (s) => Boolean(s.hover && !s.reducedMotion && s.motion === 'ready' && s.motionSrc),
  posterSrc: (s) => s.posterSrc ?? null,
  motionSrc: (s) => (s.motionSrc && s.motion !== 'none' && s.motion !== 'failed' ? s.motionSrc : null),
  motionAvailability: (s) => s.motionAvailability,
  badgeKey: (s) => {
    if (isVideo(s)) return 'badgeVideo'
    if (ANIMATED_ONLY_FAMILIES.has(s.family ?? '')) return 'badgeGif'
    if (s.animated === true) return 'badgeAnimated'
    return null
  },
  dataAttrs: (s) => ({
    'data-poster': s.poster === 'shown' ? 'shown' : s.poster === 'loading' ? 'loading' : 'icon',
    'data-motion': s.hover && !s.reducedMotion && s.motion === 'ready' && s.motionSrc ? 'playing' : s.motion,
    'data-info': s.info,
  }),
})
