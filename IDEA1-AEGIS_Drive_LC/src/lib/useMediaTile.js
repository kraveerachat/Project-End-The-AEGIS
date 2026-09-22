// src/lib/useMediaTile.js — AEGIS Drive (IDEA1) · React hook ที่ผูก state machine ของไทล์เข้ากับ scheduler/client จริง
//
// ⚠️ แบ่งหน้าที่: mediaTile.js ตัดสิน "อยากได้อะไร" (wantsInfo / wantsMotionPrefetch / shouldPlay) — hook นี้แค่
//    (1) ลงทะเบียน element กับ scheduler (แถบจาก IntersectionObserver), (2) ส่งคำขอผ่าน scheduler ตามที่ selector บอก,
//    (3) ติด src ให้ <img>/<video> "เฉพาะเมื่อ scheduler ปล่อย slot" (ไม่งั้นเบราว์เซอร์จะดึงเองเกินเพดาน),
//    (4) สั่ง play/pause ตาม shouldPlay — play() ที่ reject = PLAY_REJECTED (poster ยังอยู่ ไม่พัง)
// ⚠️ ไม่มี URL ต้นฉบับ (/preview) ในไฟล์นี้: ทุก src มาจาก media-info ที่เซิร์ฟเวอร์ให้
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { initialTileState, selectors, tileReducer } from './mediaTile.js'
import { previewKindFor } from './filesView.js'
import { useReducedMotion } from './hooks.js'

const now = () => Date.now()
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

/**
 * @param {{ file: object, scheduler: object|null, hover?: boolean|null }} o — hover: พื้นผิว hover ของการ์ดแม่ (ถ้าให้มา
 *        ไทล์จะไม่ใช้ mouse handler ของตัวเอง; การชี้ที่ใดก็ได้บนการ์ด = ชี้ที่สื่อ เหมือน Round 9)
 */
export function useMediaTile({ file, scheduler, hover = null }) {
  const previewKind = file && !file.vault && file.kind !== 'folder' ? previewKindFor(file) : null
  const contentId = previewKind && typeof file?.sha256 === 'string' && file.sha256 ? file.sha256 : null
  const family = file?.ext ? String(file.ext).toLowerCase() : null
  const reducedMotion = useReducedMotion()
  const [state, dispatch] = useReducer(tileReducer, { contentId, family, reducedMotion }, (init) => initialTileState(init))
  const elRef = useRef(null)
  const videoRef = useRef(null)
  const [posterGo, setPosterGo] = useState(null) // contentId ที่ scheduler อนุญาตให้โหลด poster แล้ว
  const [motionGo, setMotionGo] = useState(null)
  const posterWait = useRef(null)
  const motionWait = useRef(null)
  const key = contentId ? `${file.id}:${contentId}` : null

  // ตัวตนของเนื้อหาเปลี่ยน (แทนที่/กู้เวอร์ชัน) = reset; เปลี่ยนชื่อ = no-op ใน reducer
  useEffect(() => { dispatch({ type: 'CONTENT_CHANGED', contentId, family }) }, [contentId, family])
  useEffect(() => { dispatch({ type: 'REDUCED_MOTION', value: reducedMotion }); scheduler?.setMeta?.(key, { reducedMotion }) }, [reducedMotion, key, scheduler])
  // hover จากการ์ดแม่ (controlled) — เปลี่ยนค่า = เหตุการณ์ enter/leave
  useEffect(() => {
    if (hover === null || hover === undefined) return
    dispatch(hover ? { type: 'HOVER_ENTER', now: now() } : { type: 'HOVER_LEAVE' })
  }, [hover])

  // ลงทะเบียนกับ scheduler ต่อ key (id + sha) — callback ต่อไทล์: แถบ / ผล info / เริ่มโหลด poster / เริ่มโหลด motion
  useEffect(() => {
    if (!key || !scheduler || !elRef.current) return undefined
    const unregister = scheduler.register(key, elRef.current, {
      reducedMotion,
      onBand: (band) => dispatch({ type: 'VISIBILITY', band }),
      onInfo: (info) => dispatch({ type: 'INFO_LOADED', info, now: now() }),
      onPoster: (_k, { signal }) => {
        const d = deferred(); posterWait.current = d
        signal?.addEventListener('abort', () => { d.resolve('aborted') }, { once: true })
        setPosterGo(contentId)
        return d.promise
      },
      onMotion: (_k, { signal }) => {
        const d = deferred(); motionWait.current = d
        signal?.addEventListener('abort', () => { d.resolve('aborted'); setMotionGo((cur) => (cur === contentId ? null : cur)) }, { once: true })
        dispatch({ type: 'MOTION_REQUESTED' })
        setMotionGo(contentId)
        return d.promise
      },
    })
    // When IntersectionObserver is unavailable the scheduler deliberately
    // classifies registered tiles as visible. Read that synchronous fallback
    // back after registration as well as listening to onBand: some React/browser
    // combinations batch the callback fired during the passive effect itself.
    const initialBand = scheduler.bandOf?.(key)
    if (initialBand === 'visible' || initialBand === 'near') {
      dispatch({ type: 'VISIBILITY', band: initialBand })
    }
    return () => { unregister(); posterWait.current?.resolve('unmounted'); motionWait.current?.resolve('unmounted') }
    // reducedMotion ถูกส่งต่อผ่าน setMeta — ไม่ต้องลงทะเบียนใหม่
  }, [key, scheduler]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ขอ info เมื่อ selector บอก (แถบ visible/near และยังไม่รู้/ถึงเวลา poll แล้ว) ──
  const wantsInfo = selectors.wantsInfo(state, now())
  useEffect(() => {
    if (!key || !scheduler || !wantsInfo) return undefined
    if (scheduler.request(key, 'info')) dispatch({ type: 'INFO_REQUESTED' })
    return undefined
  }, [key, scheduler, wantsInfo])
  // pending: ตั้งเวลาปลุกเมื่อถึง nextInfoAt (ขอบเขตอยู่ที่ reducer: ไม่ poll ถ้าไม่อยู่ในจอ/หยุดหลังเพดาน)
  useEffect(() => {
    if (state.info !== 'pending' || state.nextInfoAt == null) return undefined
    const delay = Math.max(0, state.nextInfoAt - now())
    const timer = setTimeout(() => dispatch({ type: 'INFO_TICK', now: now() }), delay + 1)
    return () => clearTimeout(timer)
  }, [state.info, state.nextInfoAt])

  // ── poster: ขอ slot เมื่อมี URL; src ติดเมื่อ scheduler เริ่ม (posterGo === contentId) ──
  const posterSrc = selectors.posterSrc(state)
  useEffect(() => {
    if (!key || !scheduler || !posterSrc || state.poster !== 'loading' || posterGo === contentId) return
    scheduler.request(key, 'poster')
  }, [key, scheduler, posterSrc, state.poster, posterGo, contentId])

  // ── motion: prefetch ตามแถบ/hover; hover = เลื่อนขึ้นหน้าสุด ──
  const wantsMotion = selectors.wantsMotionPrefetch(state)
  const hoverPromote = selectors.hoverPromote(state)
  useEffect(() => {
    if (!key || !scheduler || !wantsMotion) return
    scheduler.request(key, 'motion')
  }, [key, scheduler, wantsMotion])
  useEffect(() => {
    if (!key || !scheduler) return
    scheduler.hover(key, Boolean(state.hover && (hoverPromote || state.motion === 'ready')))
  }, [key, scheduler, state.hover, hoverPromote, state.motion])

  // ── play/pause ตาม shouldPlay (hover ยังอยู่ + proxy พร้อม + ไม่ลดการเคลื่อนไหว) ──
  const shouldPlay = selectors.shouldPlay(state)
  const wasPlaying = useRef(false)
  useEffect(() => {
    const v = videoRef.current
    if (shouldPlay && v) {
      wasPlaying.current = true
      let cancelled = false
      Promise.resolve().then(() => v.play?.()).catch(() => { if (!cancelled) dispatch({ type: 'PLAY_REJECTED' }) })
      return () => { cancelled = true }
    }
    if (wasPlaying.current) {
      wasPlaying.current = false
      if (v) { try { v.pause?.() } catch { /* jsdom */ } try { v.currentTime = 0 } catch { /* ยังไม่มี metadata */ } }
    }
    return undefined
  }, [shouldPlay])

  const motionSrc = motionGo === contentId ? selectors.motionSrc(state) : null
  const controlled = hover !== null && hover !== undefined
  const containerProps = useMemo(() => (controlled
    ? { ref: elRef }
    : { ref: elRef, onMouseEnter: () => dispatch({ type: 'HOVER_ENTER', now: now() }), onMouseLeave: () => dispatch({ type: 'HOVER_LEAVE' }) }), [controlled])
  const posterProps = posterSrc && posterGo === contentId && state.poster !== 'none'
    ? {
        src: posterSrc, alt: '', decoding: 'async', draggable: false,
        onLoad: () => { dispatch({ type: 'POSTER_LOADED' }); posterWait.current?.resolve('loaded') },
        onError: () => { dispatch({ type: 'POSTER_ERROR' }); posterWait.current?.resolve('error') },
      }
    : null
  const videoProps = motionSrc
    ? {
        ref: videoRef, src: motionSrc, muted: true, playsInline: true, loop: true, preload: 'auto', tabIndex: -1, 'aria-hidden': 'true',
        onCanPlayThrough: () => { dispatch({ type: 'MOTION_READY' }); motionWait.current?.resolve('ready') },
        onLoadedData: () => { dispatch({ type: 'MOTION_READY' }); motionWait.current?.resolve('ready') },
        onError: () => { dispatch({ type: 'MOTION_ERROR' }); motionWait.current?.resolve('error') },
      }
    : null
  const attrs = selectors.dataAttrs(state)
  const badgeKey = selectors.badgeKey(state)
  return { state, attrs, containerProps, posterProps, videoProps, shouldPlay, badgeKey, previewKind, contentId, videoRef }
}
