import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useReducedMotion } from '../lib/hooks.js'
import { apiUrl } from '../lib/api.js'

/* ── Card — solid white paper on the gray canvas ─────────────────── */
export function Card({ children, className = '', style, onClick, interactive = Boolean(onClick) }) {
  return (
    <div
      onClick={onClick}
      data-material="solid"
      className={`ui-card bg-card rounded-[var(--r-card)] ${interactive ? 'is-interactive' : ''} ${className}`}
      style={{ boxShadow: 'var(--elev-1)', ...style }}
    >
      {children}
    </div>
  )
}

export function CardTitle({ children, sub, right }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h2 className="text-[16px] font-semibold text-ink leading-snug">{children}</h2>
        {sub && <p className="text-[12px] font-medium text-ink-3 mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

/* ── Chip — soft background + strong text, never saturated fill ──── */
const CHIP_TONES = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-accent-ink',
  violet: 'bg-violet-soft text-violet',
  neutral: 'bg-sunken text-ink-2',
}
export function Chip({ tone = 'neutral', children, className = '', mono = false }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap ${CHIP_TONES[tone]} ${mono ? 'font-mono' : ''} ${className}`}
    >
      {children}
    </span>
  )
}

/* ── Status dot — gentle 2s pulse, no glow ───────────────────────── */
const DOT_TONES = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', neutral: 'var(--ink-3)', accent: 'var(--accent)' }
export function Dot({ tone = 'ok', pulse = false, size = 8 }) {
  return (
    <span
      aria-hidden
      className={`inline-block rounded-full shrink-0 ${pulse ? 'dot-pulse' : ''}`}
      style={{ width: size, height: size, background: DOT_TONES[tone] }}
    />
  )
}

/* ── Buttons — every button is a pill ────────────────────────────── */
export function Btn({ variant = 'outline', size = 'md', className = '', children, ...rest }) {
  const sizes = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-[14px]', lg: 'h-12 px-5 text-[14px]' }
  const variants = {
    primary: 'bg-accent text-white font-semibold hover:bg-[var(--accent-ink)] active:scale-[0.98]',
    dark: 'bg-ink text-card font-semibold hover:opacity-90 active:scale-[0.98]',
    outline: 'bg-card text-ink font-medium border border-line hover:bg-sunken active:scale-[0.98]',
    ghost: 'text-ink-2 font-medium hover:bg-sunken active:scale-[0.98]',
    danger: 'bg-danger text-white font-semibold hover:opacity-90 active:scale-[0.98]',
    dangerSoft: 'bg-danger-soft text-danger font-semibold hover:opacity-85 active:scale-[0.98]',
  }
  return (
    <button
      type="button"
      className={`ui-button inline-flex items-center justify-center gap-2 rounded-full transition-[background-color,transform,opacity] duration-[var(--dur-fast)] cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100 ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconBtn({ label, className = '', children, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`ui-icon-button inline-flex items-center justify-center size-9 rounded-full text-ink-2 hover:bg-sunken hover:text-ink transition-colors duration-[var(--dur-fast)] cursor-pointer ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ── Primary gate button — restrained, no decorative particle layer ── */
const SPARKLE_SIZES = {
  lg: 'h-12 px-6 text-[14px]',
  xl: 'h-14 px-8 text-[15px]',
}
export function SparkleButton({ size = 'lg', className = '', children, ...rest }) {
  return (
    <button
      type="button"
      className={`sparkle-btn inline-flex items-center justify-center font-semibold cursor-pointer ${SPARKLE_SIZES[size]} ${className}`}
      {...rest}
    >
      <span className="sparkle-btn__label">{children}</span>
    </button>
  )
}

export function ThemeToggle({ theme, setTheme, t }) {
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="theme-toggle size-9 flex items-center justify-center rounded-full text-ink-3 bg-sunken hover:text-ink hover:bg-card border border-line transition-[color,background-color,border-color,transform] duration-[var(--dur-fast)] cursor-pointer shrink-0 active:scale-[0.96]"
    >
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      )}
    </button>
  )
}

/* ── Toggle switch ───────────────────────────────────────────────── */
export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="relative w-10 h-6 rounded-full transition-colors duration-[var(--dur-fast)] cursor-pointer shrink-0"
      style={{ background: on ? 'var(--accent)' : 'var(--line)' }}
    >
      <span
        className="absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition-transform duration-[var(--dur-fast)]"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(0)', boxShadow: 'var(--elev-1)' }}
      />
    </button>
  )
}

/* ── Segmented control (theme / language / density / view switch) ── */
export function Segmented({ options, value, onChange, ariaLabel, disabled = false }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} data-material="shell-glass" className="ui-segmented inline-flex items-center gap-0.5 bg-sunken border border-line rounded-full p-0.5">
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`ui-segmented-option h-7 px-3 rounded-full text-[12.5px] font-medium transition-[background-color,color,transform] duration-[var(--dur-fast)] cursor-pointer disabled:cursor-wait disabled:opacity-60 whitespace-nowrap ${
              active ? 'bg-ink text-card' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── Labeled pill input ──────────────────────────────────────────── */
export function Field({ id, label, right, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
          {label}
        </label>
        {right}
      </div>
      {children}
    </div>
  )
}

export function PillInput({ className = '', ...rest }) {
  return (
    <input
      className={`w-full h-12 px-4 rounded-full bg-sunken border border-line text-[14px] text-ink outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] ${className}`}
      {...rest}
    />
  )
}

export function PillSelect({ className = '', children, ...rest }) {
  return (
    <select
      className={`w-full h-10 px-4 pr-8 rounded-full bg-sunken border border-line text-[13.5px] font-medium text-ink outline-none appearance-none cursor-pointer transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] bg-no-repeat bg-[right_14px_center] ${className}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239599a1' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")",
      }}
      {...rest}
    >
      {children}
    </select>
  )
}

/* ── Modal — one global modal layer, portalled out of the screen tree ──

   ⚠️ ประวัติของบั๊กนี้อยู่ในโครงสร้าง ไม่ใช่ตัวเลข z-index:
   App shell วาง <TopBar> เป็น `sticky` + `z-index: var(--z-sticky)` ซึ่ง "สร้าง
   stacking context ของตัวเอง" ในระดับ root ส่วนตัว Modal เดิมถูก render จากใต้
   <main> → <div class="fade-in"> ซึ่ง `.fade-in` ใช้ `animation-fill-mode: both`
   บน opacity เบราว์เซอร์จึงคง stacking context ของ div นั้นไว้หลัง animation จบ
   ผลคือ `z-index: 50` ของ Modal ถูกขังอยู่ในกล่องที่มี z-index: auto — scrim จึง
   คลุม Sidebar และเนื้อหาหน้าได้ แต่ "ลอดใต้" TopBar ตลอดกาล
   การไล่เพิ่ม z-index ใน Vault.jsx จะไม่มีวันแก้ได้เลย เพราะปัญหาไม่ได้อยู่ที่ค่า

   ทางแก้จึงเป็นเชิงสถาปัตยกรรม: portal ออกไปที่ modal root ระดับ document.body
   ทำให้ scrim อยู่ใน root stacking context เดียวกับ TopBar และสูงกว่าเสมอ */

const MODAL_ROOT_ID = 'aegis-modal-root'

/* หา (หรือสร้าง) modal root ของ document ปัจจุบัน — ตั้งใจไม่ cache ไว้ระดับโมดูล
   เพราะชุดทดสอบสลับ jsdom document ได้ และ node ที่ค้างจาก document เก่าคือ node
   ที่ไม่มีวันแสดงผลอีก */
function modalPortalRoot() {
  if (typeof document === 'undefined') return null
  let root = document.getElementById(MODAL_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = MODAL_ROOT_ID
    root.setAttribute('data-aegis-modal-root', '')
    document.body.appendChild(root)
  }
  return root
}

/* ลำดับการเลือกเป้าหมายโฟกัสแรก: ตัวที่หน้าจอ "ระบุเอง" มาก่อนเสมอ แล้วค่อยเป็น
   ช่องกรอกจริงตัวแรก — ปุ่มปิดมุมขวาบนเป็นทางเลือกสุดท้าย ไม่ใช่ผู้ชนะเพียงเพราะ
   มันถูก render ก่อนใน DOM */
const MODAL_AUTOFOCUS_MARKER = '[data-modal-autofocus]:not([disabled])'
const MODAL_FORM_CONTROL = [
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
].join(', ')
const MODAL_FALLBACK_CONTROL = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/* ลำดับ Tab ภายในกล่อง — ชุดเดียวกับด้านบนแต่เรียงตามตำแหน่งใน DOM ไม่ใช่ตามลำดับ
   ความสำคัญ ใช้สำหรับ "ขัง" โฟกัสไว้ในกล่องเท่านั้น */
const MODAL_TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function initialFocusTarget(root) {
  if (!root) return null
  return root.querySelector(MODAL_AUTOFOCUS_MARKER)
    ?? root.querySelector(MODAL_FORM_CONTROL)
    ?? root.querySelector(MODAL_FALLBACK_CONTROL)
}

export function Modal({ open, onClose, children, width = 480, labelledBy }) {
  const ref = useRef(null)
  const returnFocusRef = useRef(null)

  /* onClose ที่หน้าจอส่งมามักเป็น inline arrow (`onClose={() => setModal(null)}`)
     ตัวตนของมันเปลี่ยนทุกครั้งที่ parent re-render — เก็บไว้ใน ref แล้วอ้างผ่าน ref
     เพื่อให้ Escape เรียก callback ล่าสุดเสมอ โดยที่ lifecycle ของ modal ไม่ต้อง
     ผูกกับ identity ของฟังก์ชัน */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const requestClose = useCallback(() => onCloseRef.current?.(), [])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current?.(); return }
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const stops = [...root.querySelectorAll(MODAL_TABBABLE)]
      if (stops.length === 0) { e.preventDefault(); return }
      const first = stops[0]
      const last = stops[stops.length - 1]
      const active = document.activeElement
      // โฟกัสหลุดออกไปนอกกล่องแล้ว (หรือยังไม่เคยเข้า) — ดึงกลับเข้ามา
      if (!root.contains(active)) { e.preventDefault(); first.focus(); return }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /* Remember the element that launched the dialog and return keyboard focus
     when the dialog closes. If a successful mutation removed that element,
     fail quietly instead of focusing a stale/disconnected node. */
  useEffect(() => {
    if (!open) return undefined
    returnFocusRef.current = document.activeElement
    return () => {
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target?.isConnected && typeof target.focus === 'function') target.focus()
    }
  }, [open])

  /* โฟกัสเริ่มต้นเกิดเฉพาะตอน "เพิ่งเปิด" เท่านั้น — พิมพ์ลงช่อง controlled แล้ว
     หน้าจอ re-render ต้องไม่ดึงโฟกัสออกจากช่องที่ผู้ใช้กำลังพิมพ์อยู่ */
  useEffect(() => {
    if (!open) return
    initialFocusTarget(ref.current)?.focus()
  }, [open])

  if (!open) return null
  const portalRoot = modalPortalRoot()
  if (!portalRoot) return null

  /* ชั้นเดียว หนึ่ง scrim: การหรี่ + เบลอทั้งหมดอยู่ใน .modal-scrim (index.css)
     ไม่ใช่ inline style ซ้ำ ๆ ต่อจอ และไม่ใช่การเบลอ TopBar แยกชิ้น */
  return createPortal(
    <div className="modal-layer">
      <div className="modal-scrim fade-in" onClick={requestClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-material="shell-glass"
        className="ui-modal modal-card relative bg-card rounded-[var(--r-card)] p-6 rise-in max-h-[85vh] overflow-y-auto w-full"
        style={{ maxWidth: width, boxShadow: 'var(--elev-2)' }}
      >
        {children}
      </div>
    </div>,
    portalRoot,
  )
}

export function ModalClose({ onClose, label = 'Close' }) {
  return (
    <IconBtn label={label} onClick={onClose} className="absolute top-4 right-4">
      <X size={16} strokeWidth={1.5} />
    </IconBtn>
  )
}

/* ── Sparkline — hand-rolled, 2px line, no chart chrome ──────────── */
export function Sparkline({ data, color = 'var(--accent)', width = 120, height = 32, strokeWidth = 2, fill = false, className = '' }) {
  if (!data?.length) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pad = strokeWidth
  const pts = data.map((v, i) => [
    pad + (i / (data.length - 1)) * (width - pad * 2),
    height - pad - ((v - min) / span) * (height - pad * 2),
  ])
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none" aria-hidden>
      {fill && <path d={area} fill={color} opacity="0.1" />}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ── SVG hatch patterns for Recharts fills (fill="url(#…)") ──────── */
export function HatchDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <pattern id="hatch-ink" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink)" strokeWidth="1.4" opacity="0.55" />
        </pattern>
        <pattern id="hatch-accent" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" strokeWidth="1.4" opacity="0.6" />
        </pattern>
        <pattern id="hatch-line" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink-3)" strokeWidth="1.2" opacity="0.5" />
        </pattern>
      </defs>
    </svg>
  )
}

/* ── Check that draws itself ─────────────────────────────────────── */
export function DrawnCheck({ size = 16, color = 'var(--ok)', animate = true }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3 8.5l3.2 3.2L13 4.5"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? 'draw-check' : ''}
      />
    </svg>
  )
}

/* ── ScrambleHash — split-flap cycling hex that locks left→right ───
   Used for SHA-256 verify + the upload HASHING stage.               */
const HEX = '0123456789abcdef'
export function ScrambleHash({ hash, playing, duration = 900, onDone, groupClass = '' }) {
  const reduced = useReducedMotion()
  const [display, setDisplay] = useState(hash)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (!playing) {
      setDisplay(hash)
      return
    }
    if (reduced) {
      setDisplay(hash)
      doneRef.current?.()
      return
    }
    const t0 = performance.now()
    let raf
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration)
      const locked = Math.floor(p * hash.length)
      let out = hash.slice(0, locked)
      for (let i = locked; i < hash.length; i += 1) out += HEX[(Math.random() * 16) | 0]
      setDisplay(out)
      if (p < 1) raf = requestAnimationFrame(tick)
      else doneRef.current?.()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, hash, duration, reduced])

  const groups = display.match(/.{1,8}/g) ?? [display]
  return (
    <span className={`font-mono text-[12px] leading-relaxed break-all ${groupClass}`}>
      {groups.map((g, i) => (
        <span key={i} className="inline-block mr-2 last:mr-0">
          {g}
        </span>
      ))}
    </span>
  )
}

/* ── Uppercase table header cell ─────────────────────────────────── */
export function Th({ children, className = '' }) {
  return (
    <th className={`text-left text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em] px-4 py-2.5 whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

/* ── Thin progress bar ───────────────────────────────────────────── */
export function Progress({ value, color = 'var(--accent)', height = 4, track = 'var(--line)', className = '' }) {
  return (
    <div className={`w-full rounded-full overflow-hidden ${className}`} style={{ height, background: track }}>
      <div
        className="h-full rounded-full transition-[width] duration-[var(--dur-base)]"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color, transitionTimingFunction: 'var(--ease)' }}
      />
    </div>
  )
}

/* ── Empty state — hatched, because nothing is here ──────────────── */
/* ── Skeleton loader — shaped like the real content for transitions ── */
export function SkeletonLoader({ type = 'generic' }) {
  if (type === 'dashboard') {
    return (
      <div className="grid grid-cols-12 gap-6 animate-pulse">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="col-span-3 max-lg:col-span-6 max-md:col-span-12 bg-card rounded-[var(--r-card)] p-6 h-36 flex flex-col justify-between" style={{ boxShadow: 'var(--elev-1)' }}>
            <div className="flex justify-between">
              <div className="size-10 rounded-xl skeleton" />
              <div className="w-14 h-5 rounded-full skeleton" />
            </div>
            <div className="w-24 h-4 skeleton mt-4" />
            <div className="w-32 h-8 skeleton mt-1" />
          </div>
        ))}
        <div className="col-span-8 max-lg:col-span-12 bg-card rounded-[var(--r-card)] p-6 h-80 flex flex-col justify-between" style={{ boxShadow: 'var(--elev-1)' }}>
          <div className="w-48 h-6 skeleton" />
          <div className="flex flex-col gap-4 mt-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 rounded-xl skeleton" />
            ))}
          </div>
        </div>
        <div className="col-span-4 max-lg:col-span-12 bg-card rounded-[var(--r-card)] p-6 h-80 flex flex-col gap-4" style={{ boxShadow: 'var(--elev-1)' }}>
          <div className="w-32 h-6 skeleton" />
          <div className="flex flex-col gap-3.5 flex-1 mt-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-xl skeleton" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (type === 'table') {
    return (
      <div className="bg-card rounded-[var(--r-card)] p-6 animate-pulse" style={{ boxShadow: 'var(--elev-1)' }}>
        <div className="flex justify-between items-center mb-6">
          <div className="w-36 h-6 skeleton" />
          <div className="w-20 h-8 rounded-full skeleton" />
        </div>
        <div className="flex flex-col gap-3.5">
          <div className="flex gap-4 border-b border-line pb-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex-1 h-5 skeleton" />
            ))}
          </div>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex gap-4 py-2 border-b border-line last:border-b-0">
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="flex-1 h-6 rounded-md skeleton" />
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (type === 'files') {
    return (
      <div className="flex flex-col gap-6 animate-pulse">
        <div className="flex justify-between items-center">
          <div className="w-48 h-8 rounded-full skeleton" />
          <div className="flex gap-2">
            <div className="w-24 h-10 rounded-full skeleton" />
            <div className="w-24 h-10 rounded-full skeleton" />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-3 max-md:grid-cols-2 max-sm:grid-cols-1">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="bg-card rounded-[var(--r-card)] p-5 h-44 flex flex-col justify-between" style={{ boxShadow: 'var(--elev-1)' }}>
              <div className="flex justify-between">
                <div className="size-10 rounded-xl skeleton" />
                <div className="size-6 rounded-full skeleton" />
              </div>
              <div className="flex flex-col gap-2 mt-4">
                <div className="w-3/4 h-5 skeleton" />
                <div className="w-1/2 h-4 skeleton" />
              </div>
              <div className="w-full h-1.5 rounded-full mt-2 skeleton" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-[var(--r-card)] p-6 h-96 flex flex-col gap-4 animate-pulse" style={{ boxShadow: 'var(--elev-1)' }}>
      <div className="w-1/3 h-6 skeleton" />
      <div className="w-full h-4 skeleton mt-4" />
      <div className="w-5/6 h-4 skeleton" />
      <div className="w-4/5 h-4 skeleton" />
      <div className="flex-1 rounded-2xl skeleton mt-6" />
    </div>
  )
}

/* ── Error state — จอที่เชื่อม backend ไม่ได้ต้อง "บอก + ให้ทางไปต่อ" เสมอ ─────
   ห้ามปล่อยจอขาว/ค้าง: มีข้อความอ่านรู้เรื่อง + ปุ่ม Retry ที่ทำงานจริง (useApi.retry) */
export function ErrorState({ t, onRetry, kind = 'server' }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center text-center gap-3 py-14 px-6">
      <span className="flex items-center justify-center size-12 rounded-full bg-danger-soft">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
      </span>
      <p className="text-[15px] font-semibold text-ink">{t('errLoadTitle')}</p>
      <p className="text-[13px] text-ink-2 max-w-[44ch] leading-relaxed">
        {kind === 'timeout' ? t('errLoadTimeout') : t('errLoadHint')}
      </p>
      <Btn variant="outline" size="sm" onClick={onRetry} className="mt-1">
        {t('retry')}
      </Btn>
    </div>
  )
}

/* ── Empty state — hatch = "the system cannot see anything here" (DESIGN.md) ──
   ไม่ใช่แถวปลอม ไม่ใช่จอว่างเปล่า: บอกว่าที่นี่ยังไม่มีอะไร และ (ถ้ามี) จะเริ่มยังไง */
export function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center text-center gap-3 py-14 px-6">
      <span className="flex items-center justify-center size-12 rounded-[var(--r-tile)] hatch hatch-ink3 bg-sunken border border-line">
        {Icon && <Icon size={20} strokeWidth={1.5} className="text-ink-3" aria-hidden />}
      </span>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {hint && <p className="text-[13px] text-ink-2 max-w-[44ch] leading-relaxed">{hint}</p>}
      {action}
    </div>
  )
}

/* Compact empty state for a table/list body. The surrounding card, header, and
   controls stay mounted; only the data row becomes quiet placeholder copy. */
export function InlineEmptyState({ children, action, className = '' }) {
  return (
    <div
      role="status"
      className={`min-h-14 px-5 py-4 flex items-center justify-center gap-3 text-center text-[12.5px] text-ink-3 ${className}`}
    >
      <span>{children}</span>
      {action}
    </div>
  )
}

/* ── Not-yet-implemented marker ────────────────────────────────────────────────
   ⚠️ กติกาของโปรเจกต์นี้: จอห้ามแสดงข้อมูลที่แต่งขึ้นเพื่อให้ดูสมบูรณ์ อะไรที่ยังไม่มี
   ของจริงต้องบอกตรง ๆ ว่ายังไม่มี — เพราะตัวเลข/สถานะปลอมที่ดูน่าเชื่อจะถูกเอาไป
   ตัดสินใจจริง (ผู้ดูแลเห็น "SMART: PASSED" แล้วเลิกตรวจดิสก์ / เห็น "rotated 31 วันก่อน"
   แล้วเชื่อว่าทำ key rotation ตามรอบแล้ว) การเว้นว่างไว้ปลอดภัยกว่าการเดาให้ดูดี
   ใช้ hatch เป็นภาษาเดียวกับ EmptyState: ลายขวาง = "ระบบมองไม่เห็นอะไรที่นี่" */
export function NotYetImplemented({ label, children }) {
  return (
    <div
      role="note"
      className="rounded-[var(--r-tile)] border border-dashed border-line bg-sunken px-4 py-3.5 flex gap-3"
    >
      <span aria-hidden className="mt-0.5 size-5 shrink-0 rounded-[6px] hatch hatch-ink3 border border-line" />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</p>
        {children && <p className="text-[12.5px] text-ink-2 leading-relaxed mt-1 max-w-[56ch]">{children}</p>}
      </div>
    </div>
  )
}

/* ── Avatar — รูปโปรไฟล์จริงจากเซิร์ฟเวอร์ ถ้ายังไม่มีก็ใช้อักษรย่อ ────────────────
   ⚠️ ไม่ถามเซิร์ฟเวอร์ก่อนว่า "มีรูปไหม" โดยเจตนา: ปล่อยให้ image element ไปเอาแล้วถ้า 404
   ก็ตกลงมาที่อักษรย่อเอง — ประหยัดหนึ่ง round trip ต่อการ render ทุกครั้ง และ
   self-correcting (รูปถูกลบทีหลังก็ตกกลับมาเองโดยไม่ต้องมีใคร invalidate cache)
   ⚠️ userId ใช้ประกอบ URL อย่างเดียว ไม่ใช่ credential — endpoint ยังต้องล็อกอินอยู่ดี */
export function Avatar({ userId, name, size = 40, className = '' }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const initials = String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?'

  const box = {
    width: size,
    height: size,
    fontSize: Math.max(10, Math.round(size * 0.34)),
  }

  return (
    <span
      aria-hidden
      style={box}
      className={`relative rounded-full bg-ink text-card font-bold flex items-center justify-center shrink-0 overflow-hidden ${className}`}
    >
      {initials}
      {!failed && userId != null && (
        <img
          src={apiUrl(`/api/users/${encodeURIComponent(userId)}/avatar`)}
          alt=""
          width={size}
          height={size}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 rounded-full object-cover bg-sunken transition-opacity duration-[var(--dur-fast)] ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </span>
  )
}

/* A missing dependency is not the same thing as an empty collection. Keep the
   surrounding page chrome mounted, but state clearly that data cannot be read. */
export function DependencyUnavailableState({ t, title, compact = false, className = '' }) {
  return (
    <div role="status" aria-live="polite" className={`flex ${compact ? 'items-center text-left' : 'flex-col items-center text-center'} justify-center gap-3 ${compact ? 'px-5 py-4' : 'px-6 py-10'} hatch hatch-ink3 rounded-[var(--r-tile)] border border-dashed border-line bg-sunken ${className}`}>
      <span className="size-9 shrink-0 rounded-[9px] border border-line bg-card flex items-center justify-center" aria-hidden>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2v4M16 2v4M7 10h10M12 14v3M9 20h6" />
          <rect x="5" y="6" width="14" height="8" rx="2" />
        </svg>
      </span>
      <span className={compact ? 'min-w-0' : ''}>
        <span className="block text-[13.5px] font-semibold text-ink">{title}</span>
        <span className={`block text-[12px] text-ink-2 leading-relaxed ${compact ? 'mt-0.5' : 'mt-1 max-w-[52ch]'}`}>{t('dependencyUnavailableHint')}</span>
      </span>
    </div>
  )
}

export function Reveal({ children, delay = 0 }) {
  const ref = useRef(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          entry.target.animate(
            [
              { opacity: 0.01, transform: 'translateY(8px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ],
            { duration: 220, delay, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'none' },
          )
          observer.unobserve(entry.target)
        }
      },
      { threshold: 0.05 }
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [delay, reduced])

  return (
    <div ref={ref} className="dashboard-reveal">
      {children}
    </div>
  )
}
