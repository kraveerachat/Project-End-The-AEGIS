import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Cctv, Database, LayoutDashboard, LogOut } from 'lucide-react'
import { getModulesForRole } from '../lib/modules.js'
import { useReducedMotion } from '../lib/hooks.js'
import { AegisMark } from '../components/AegisMark.jsx'
import { Btn, Chip, Segmented, ThemeToggle } from '../components/ui.jsx'
import { LANGS } from '../lib/strings.js'
import { EASE } from '../lib/motion.js'

const ICONS = { drive: Database, cctv: Cctv, monitoring: LayoutDashboard }

/* The grid's entrance. Cards arrive one by one on load — a launcher
   earns a reveal; the Hub's task surface below it does not. */
const gridParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } },
}
const gridChild = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
}

function ModuleCard({ t, module, dimmed, onOpen }) {
  const Icon = ICONS[module.id]
  return (
    // Two elements, two jobs: the wrapper is the stagger child (parent
    // variants drive it), the button owns hover/press/dim. Merging them
    // would make the entrance and the press fight over `transform`.
    <motion.div variants={gridChild} className="w-[340px] max-w-full">
      <motion.button
        type="button"
        onClick={() => onOpen(module)}
        animate={{ opacity: dimmed ? 0.35 : 1 }}
        whileHover={{ y: -4 }}
        whileFocus={{ y: -4 }}
        whileTap={{ scale: 0.98 }}
        transition={{ duration: 0.24, ease: EASE }}
        className="module-card group w-full h-full min-h-[280px] flex flex-col items-start text-left bg-card rounded-(--r-card) p-7 cursor-pointer"
      >
        {/* icon chip warms to the accent tint as the card lifts */}
        <span className="flex items-center justify-center size-[72px] rounded-(--r-tile) bg-sunken transition-colors duration-(--dur-base) group-hover:bg-accent-soft">
          <Icon size={40} strokeWidth={1.5} style={{ color: 'var(--accent)' }} aria-hidden />
        </span>
        <span className="block text-[18px] font-bold tracking-[-0.01em] text-ink mt-5">{t(module.titleKey)}</span>
        <span className="block text-[13.5px] text-ink-2 mt-1.5 leading-relaxed">{t(module.descKey)}</span>
        <span className="flex items-center gap-1.5 mt-auto pt-5 text-[12px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--accent)' }}>
          {t('open')}
          <ArrowRight size={14} strokeWidth={2} className="transition-transform duration-(--dur-base) group-hover:translate-x-1" aria-hidden />
        </span>
      </motion.button>
    </motion.div>
  )
}

/**
 * Screen 3 — the menu. A launcher, not an application. Module cards are
 * placeholders: clicking shows "Entering [module]…" briefly, then returns.
 *
 * การ์ดถูก filter ตาม role "ก่อน" .map() — โมดูลที่ไม่มีสิทธิ์ไม่มีอยู่ใน
 * DOM เลย (ดูคอมเมนต์ยาวใน lib/modules.js) และ role chip ด้านขวาบนเป็นแค่
 * "จอแสดงผล" ของสิ่งที่เซิร์ฟเวอร์ตัดสินมา — ไม่ใช่ปุ่ม กดไม่ได้ เปลี่ยนอะไรไม่ได้
 */
export function Hub({ t, lang, setLang, session, theme, setTheme, onLogout }) {
  const reduced = useReducedMotion()
  const [entering, setEntering] = useState(null) // null | module
  const timerRef = useRef(0)

  const modules = getModulesForRole(session.role)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  function openModule(module) {
    if (entering) return
    setEntering(module)
    // placeholder — the real sub-application gets wired in much later
    timerRef.current = setTimeout(() => setEntering(null), reduced ? 600 : 1200)
  }

  return (
    <div className="min-h-full flex flex-col bg-canvas">
      {/* header — no sidebar, no breadcrumbs, no search */}
      <header className="flex items-center justify-between px-6 py-4 max-sm:px-4" style={{ zIndex: 'var(--z-chrome)' }}>
        <div className="flex items-center gap-2.5 shrink-0">
          <AegisMark size={28} />
          <span className="font-bold text-[16px] tracking-[-0.02em] text-ink max-sm:hidden">AEGIS</span>
        </div>
        <div className="flex items-center gap-3 max-sm:gap-1.5">
          <Chip tone={session.role === 'admin' ? 'accent' : 'neutral'}>
            {session.role === 'admin' ? t('roleAdmin') : t('roleUser')}
          </Chip>
          <ThemeToggle theme={theme} setTheme={setTheme} t={t} />
          <Segmented
            ariaLabel={t('language')}
            options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
            value={lang}
            onChange={setLang}
          />
          <Btn variant="ghost" size="sm" onClick={onLogout} aria-label={t('logout')}>
            <LogOut size={15} strokeWidth={1.5} aria-hidden />
            <span className="max-sm:hidden">{t('logout')}</span>
          </Btn>
        </div>
      </header>

      {/* greeting + cards — the only content on the page */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="text-center rise-in">
          <h1 className="text-[30px] font-semibold tracking-[-0.02em] text-ink">
            {t('welcomeUser', { name: session.displayName })}
          </h1>
          <p className="text-[14px] text-ink-3 mt-1.5">{t('selectModule')}</p>
        </div>

        {/* one card must look deliberate, not broken — the wrap centers it */}
        <motion.div
          variants={gridParent}
          initial="hidden"
          animate="show"
          className="flex flex-wrap items-stretch justify-center gap-6 mt-12 w-full max-w-[1120px]"
        >
          {modules.map((m) => (
            <ModuleCard key={m.id} t={t} module={m} dimmed={!!entering && entering.id !== m.id} onOpen={openModule} />
          ))}
        </motion.div>
      </main>

      {/* Entering [module]… — brief placeholder overlay, then return */}
      {entering && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 flex items-center justify-center fade-in"
          style={{ zIndex: 'var(--z-overlay)', background: 'color-mix(in srgb, var(--canvas) 55%, transparent)' }}
        >
          <div
            className="bg-card rounded-(--r-card) px-10 py-8 flex flex-col items-center gap-4 rise-in"
            style={{ boxShadow: 'var(--elev-2)' }}
          >
            {(() => {
              const Icon = ICONS[entering.id]
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
