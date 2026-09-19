// src/components/MediaThumb.jsx — AEGIS Drive (IDEA1) · thumbnail ของไฟล์ปกติจาก derivative ฝั่งเซิร์ฟเวอร์ (spec §15, plan Task 13)
//
// ชั้นภาพ (ล่าง → บน): ไอคอนชนิดไฟล์ (อยู่เสมอ) → poster <img> (เมื่อเซิร์ฟเวอร์มีให้) → motion <video> ทับ (เฉพาะขณะชี้)
// ⚠️ poster ยัง mount อยู่ใต้ video เสมอ — การเล่น/หยุด/โหลดไม่เคยทำให้ไทล์ว่าง; ไม่มี URL ต้นฉบับ (/preview) ที่นี่:
//    ทุก src มาจาก media-info (ทึบ) — ต้นฉบับใช้เฉพาะใน FilePreviewModal (ผู้ใช้กด Preview เอง)
// ⚠️ Vault/โฟลเดอร์/ชนิดที่ไม่รองรับ = ไอคอนเดิม + ป้ายที่พูดความจริง; MEDIA_ENABLED=false = เหมือนกัน ไม่มี retry storm
import { createContext, useContext, useEffect, useMemo } from 'react'
import { useMediaTile } from '../lib/useMediaTile.js'
import { createMediaScheduler } from '../lib/mediaScheduler.js'
import { createMediaInfoClient } from '../lib/mediaApi.js'

const MediaContext = createContext(null)

/** ประกอบ scheduler + client หนึ่งชุดต่อหน้า Files: onInfo(keys) → หนึ่ง batch → ส่งผลกลับตาม key (id:sha) */
export function createMediaRuntime({ client = createMediaInfoClient(), createObserver } = {}) {
  const scheduler = createMediaScheduler({
    ...(createObserver ? { createObserver } : {}),
    onInfo: async (keys) => {
      const out = new Map()
      const byId = new Map()
      for (const key of keys) byId.set(key, key.slice(0, key.indexOf(':')))
      const infos = await Promise.all([...byId.values()].map((id) => client.request(id)))
      const ids = [...byId.values()]
      for (let i = 0; i < ids.length; i += 1) for (const [key, id] of byId) if (id === ids[i]) out.set(key, infos[i])
      return out
    },
    onPoster: async () => {},
    onMotion: async () => {},
  })
  return { scheduler, client, dispose: () => { scheduler.dispose(); client.dispose?.() } }
}

let sharedRuntime = null
const sharedMediaRuntime = () => { if (!sharedRuntime) sharedRuntime = createMediaRuntime(); return sharedRuntime }

/** ผู้ให้บริการ scheduler/client — FilesSections สร้างหนึ่งชุดต่อ instance; ถ้าไม่มี provider ใช้ชุดร่วมของโมดูล */
export function MediaProvider({ scheduler, client, children }) {
  const value = useMemo(() => ({ scheduler, client }), [scheduler, client])
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>
}
export function useMediaRuntime() {
  const ctx = useContext(MediaContext)
  return ctx ?? sharedMediaRuntime()
}
/** hook สำหรับเจ้าของหน้า: สร้าง runtime ของตัวเองและทิ้งตอน unmount */
export function useOwnedMediaRuntime() {
  const runtime = useMemo(() => createMediaRuntime(), [])
  useEffect(() => () => runtime.dispose(), [runtime])
  return runtime
}

const thumbVariant = (state, hasPoster, hasVideo, playing) => (playing && hasVideo ? 'motion' : hasPoster && state.poster === 'shown' ? 'poster' : 'icon')

/**
 * @param {{ t: Function, file: object, Icon: Function, iconProps?: object, className?: string, badge?: boolean, hover?: boolean|null }} props
 */
export function MediaThumb({ t, file, Icon, iconProps = {}, className = '', badge = true, hover = null, children }) {
  const { scheduler } = useMediaRuntime()
  const tile = useMediaTile({ file, scheduler, hover })
  const { state, attrs, containerProps, posterProps, videoProps, shouldPlay, badgeKey } = tile
  const showBadge = badge && badgeKey && state.poster !== 'shown'
  const pending = state.info === 'pending' || state.info === 'loading'
  const showPendingLabel = pending && state.poster !== 'shown' && (state.info === 'pending')
  return (
    <div
      {...containerProps}
      data-media-thumb=""
      data-thumb={thumbVariant(state, Boolean(posterProps), Boolean(videoProps), shouldPlay)}
      {...attrs}
      className={`relative overflow-hidden flex items-center justify-center ${className}`}
    >
      {/* ชั้นล่างสุด: ไอคอนชนิดไฟล์ — คงอยู่เสมอ (ซ่อนด้วยความทึบเมื่อ poster แสดง ไม่ใช่ถอดออก) */}
      <span className="relative inline-flex items-center justify-center transition-opacity duration-[var(--dur-fast)]" style={{ opacity: state.poster === 'shown' ? 0 : 1 }} aria-hidden={state.poster === 'shown' ? 'true' : undefined}>
        {children ?? (Icon ? <Icon {...iconProps} /> : null)}
        {showBadge && (
          <span data-media-badge={badgeKey} className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-[4px] border border-line bg-card px-1 text-[9px] font-semibold tracking-[0.06em] text-ink-3 whitespace-nowrap">
            {t(badgeKey)}
          </span>
        )}
      </span>
      {showPendingLabel && (
        <span data-media-pending="" className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-[4px] bg-card/80 px-1 text-[9px] text-ink-3 whitespace-nowrap">{t('mediaPending')}</span>
      )}
      {posterProps && (
        <img
          {...posterProps}
          className="absolute inset-0 size-full object-cover transition-opacity duration-[var(--dur-fast)]"
          style={{ opacity: state.poster === 'shown' ? 1 : 0 }}
        />
      )}
      {videoProps && (
        <video
          {...videoProps}
          className="absolute inset-0 size-full object-cover pointer-events-none"
          style={{ opacity: shouldPlay ? 1 : 0 }}
        />
      )}
    </div>
  )
}
