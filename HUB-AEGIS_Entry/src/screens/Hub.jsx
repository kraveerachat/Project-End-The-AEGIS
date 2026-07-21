import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Database, LayoutDashboard } from 'lucide-react'
import { useReducedMotion } from '../lib/hooks.js'
import { AegisMark } from '../components/AegisMark.jsx'
import { LuminousModuleCard } from '../components/LuminousModuleCard.jsx'
import { Segmented, ThemeToggle } from '../components/ui.jsx'
import { LANGS } from '../lib/strings.js'
import { EASE } from '../lib/motion.js'

/* ⚠️ HUB เป็น traffic router ล้วน ๆ — รายการโมดูลเป็น "ดัชนีสาธารณะ" คงที่
   ไม่มี role, ไม่มีการกรองสิทธิ์ที่นี่: การตัดสินว่าใครเข้าอะไรได้เกิดหลัง
   ล็อกอิน "ในแอปปลายทาง" เท่านั้น (Drive และ Monitor ต่างมี identity ของตัวเอง)
   การรู้ว่าโมดูลชื่ออะไรไม่ใช่ความลับ — ความลับคือข้อมูลข้างใน ซึ่งอยู่หลัง
   login + RBAC ของแอปนั้น ๆ ทั้งหมด */
const MODULES = [
  { id: 'drive', titleKey: 'modDrive', descKey: 'modDriveDesc', icon: Database },
  { id: 'monitoring', titleKey: 'modMonitor', descKey: 'modMonitorDesc', icon: LayoutDashboard },
]

// ปลายทางเริ่มต้น (dev) — production ทับค่าด้วย /config.json ที่แก้ได้บนเครื่อง
// deploy โดยไม่ต้อง rebuild (ไม่มี IP ฝังตายใน bundle)
const DEFAULT_TARGETS = {
  drive: 'http://localhost:5174/',
  monitoring: 'http://localhost:5176/',
}

/* The index's entrance. Rows arrive one by one — a launcher earns a
   reveal; the module it launches into does not. */
const indexParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.06 } },
}
const indexChild = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE } },
}

/**
 * Screen 2 — the menu. A launcher, not an application: user selects a
 * module and is handed to that module's own login (per-app identity).
 */
export function Hub({ t, lang, setLang, theme, setTheme }) {
  const reduced = useReducedMotion()
  const [entering, setEntering] = useState(null) // null | module
  const [targets, setTargets] = useState(DEFAULT_TARGETS)
  const timerRef = useRef(0)

  // runtime config — เสิร์ฟจาก origin ตัวเอง (CSP connect-src 'self')
  useEffect(() => {
    let alive = true
    fetch('/config.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (alive && cfg?.modules) setTargets((prev) => ({ ...prev, ...cfg.modules }))
      })
      .catch(() => { /* ไม่มี config — ใช้ค่า dev เริ่มต้น */ })
    return () => { alive = false }
  }, [])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  function openModule(module) {
    if (entering) return
    setEntering(module)
    const target = targets[module.id]
    timerRef.current = setTimeout(() => {
      // ส่งต่อไปยังแอปปลายทาง — ที่นั่นคือที่ที่การล็อกอินเกิดขึ้นจริง
      window.location.href = target
    }, reduced ? 400 : 800)
  }

  return (
    // The Hub joins the gate on the photograph. PRODUCT.md: the hub is a
    // threshold they pass through, not a place they linger.
    <div className="relative flex-1 flex flex-col gate-bg">
      {/* the veil that makes text on the photograph legible — see .hub-halo */}
      <div aria-hidden className="hub-halo absolute inset-0 pointer-events-none" />

      {/* header — no session chrome: HUB has no user, no role, no logout. */}
      <header
        className="relative flex items-center justify-between px-6 py-4 max-sm:px-4 border-b"
        style={{ zIndex: 'var(--z-chrome)', borderColor: 'var(--hairline)' }}
      >
        <div className="flex items-center gap-2.5 shrink-0">
          <AegisMark size={28} />
          <span className="font-bold text-[16px] tracking-[-0.02em] bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 bg-clip-text text-transparent max-sm:hidden">AEGIS</span>
        </div>
        <div className="flex items-center gap-3 max-sm:gap-1.5">
          <ThemeToggle theme={theme} setTheme={setTheme} t={t} />
          <Segmented
            ariaLabel={t('language')}
            options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
            value={lang}
            onChange={setLang}
          />
        </div>
      </header>

      {/* greeting + index — the only content on the page. */}
      <main className="relative flex-1 flex flex-col justify-center items-center px-6 max-sm:px-5 py-16">
        <motion.div
          variants={indexParent}
          initial="hidden"
          animate="show"
          className="w-full max-w-[1080px]"
        >
          <motion.div variants={indexChild}>
            <h1
              className="font-bold tracking-[-0.02em] text-ink leading-[1.2] text-balance"
              style={{ fontSize: 'clamp(30px, 4.6vw, 58px)' }}
            >
              {t('hubTitle')}
            </h1>
            <p className="mt-3 text-[13px] font-medium tracking-[0.1em] text-ink-2">{t('selectModule')}</p>
          </motion.div>

          {/* gap-12: each card's bracket frame paints 1rem OUTSIDE its box. */}
          <div
            className="mt-12 sm:mt-14 grid gap-12 justify-center"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 20rem))' }}
          >
            {MODULES.map((m) => (
              <LuminousModuleCard
                key={m.id}
                variants={indexChild}
                title={t(m.titleKey)}
                description={t(m.descKey)}
                icon={m.icon}
                live={entering?.id === m.id}
                dimmed={!!entering && entering.id !== m.id}
                onClick={() => openModule(m)}
              />
            ))}
          </div>
        </motion.div>
      </main>

      {/* Entering [module]… — brief overlay while handing off */}
      {entering && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 flex items-center justify-center fade-in"
          style={{ zIndex: 'var(--z-overlay)', background: 'color-mix(in srgb, var(--canvas) 82%, transparent)' }}
        >
          <div
            className="bg-card rounded-(--r-card) px-10 py-8 flex flex-col items-center gap-4 rise-in"
            style={{ boxShadow: 'var(--elev-2)' }}
          >
            {(() => {
              const Icon = entering.icon
              return (
                <span className="flex items-center justify-center size-12 rounded-(--r-tile) bg-accent-soft">
                  <Icon size={26} strokeWidth={1.5} style={{ color: 'var(--accent)' }} aria-hidden />
                </span>
              )
            })()}
            <p className="text-[15px] font-semibold text-ink">
              {t('entering', { module: t(entering.titleKey) })}
            </p>
            <div className="w-[220px] h-1 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
              <div className="h-full w-2/5 rounded-full slide-x" style={{ background: 'var(--accent)' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
