import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Welcome } from './screens/Welcome.jsx'
import { Hub } from './screens/Hub.jsx'
import { Segmented, ThemeToggle } from './components/ui.jsx'
import { LANGS, makeT } from './lib/strings.js'
import { EASE, SPRING } from './lib/motion.js'
import { readShellTheme, resolveShellTheme, SHELL_THEME_KEY, isValidShellTheme } from './lib/shellTheme.js'

/**
 * AEGIS Entry Point Hub — a door and a menu. Two screens, one state
 * machine, no routing library.
 *
 * ⚠️ HUB ไม่มีการล็อกอินเป็นของตัวเอง — ไม่มีฟอร์ม ไม่มี session ไม่มี
 * cookie ไม่มี DB และไม่มี backend (ดู gateway/Dockerfile: runtime stage
 * เอาไปแค่ dist/) มันคือ "ป้ายบอกทาง" ล้วน ๆ ตามหลัก Identity Decoupling:
 * การพิสูจน์ตัวตนเกิดขึ้นในแอปปลายทางเท่านั้น — Drive และ Monitor ต่างมี
 * login + bcrypt + session cookie + ฐานข้อมูลของตัวเอง แยกขาดจากกัน
 *
 * เดิมที่นี่เคยมีฟอร์มล็อกอินที่ "fallback มาเช็ครหัสผ่านฝั่ง client" เมื่อ
 * ยิง /api/login แล้วไม่มี backend ตอบ — นั่นคือการแจก session ระดับ Admin
 * โดยไม่มีการบังคับฝั่งเซิร์ฟเวอร์เลย ทั้งฟอร์มและ fallback ถูกลบทิ้งแล้ว
 * ไม่ใช่แค่ปิดไว้ (ดู log.md)
 *
 * Welcome นั่งอยู่ใน vault card ใบเดียวกลางประตู แล้วส่งต่อไป Hub ซึ่งเป็น
 * หน้าเลือกแอป การ์ดที่นั่นพาออกจาก SPA นี้ไปยังแอปจริงหลัง gateway
 *
 * The gate is full-bleed (`.gate-bg`): BG_AEGIS01/02 swap on theme and
 * their fibre streaks converge on an empty centre — the vault sits in
 * that void.
 */
export default function App() {
  // AEGIS CORE ENTRY UX CONTRACT — HUMAN OWNER CONTROLLED.
  // Welcome and Hub are separate reversible entries. Changes require explicit
  // scope, RED regression evidence, preserved auth semantics, Human/integration review.
  // Do not weaken this warning during incidental UI cleanup.
  const [screen, setScreen] = useState(
    () => window.history.state?.aegisHubScreen === 'hub' ? 'hub' : 'welcome',
  ) // 'welcome' | 'hub'
  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  const [theme, setTheme] = useState(() => readShellTheme())
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const resolvedTheme = resolveShellTheme(theme, prefersDark)

  const t = makeT(lang)

  function enterHub() {
    window.history.pushState({ ...(window.history.state || {}), aegisHubScreen: 'hub' }, '')
    setScreen('hub')
  }

  useEffect(() => {
    const onPopState = () => setScreen(window.history.state?.aegisHubScreen === 'hub' ? 'hub' : 'welcome')
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    const dark = resolvedTheme === 'dark'
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.classList.toggle('light', !dark)
    localStorage.setItem(SHELL_THEME_KEY, theme)

    const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
    link.type = 'image/png'
    link.rel = 'shortcut icon'
    link.href = dark ? '/assets/logo/aegis-mark-dark-ink.png' : '/assets/logo/aegis-mark-light-ink.png'
    if (!link.parentNode) document.getElementsByTagName('head')[0].appendChild(link)
  }, [theme, resolvedTheme])

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === SHELL_THEME_KEY && isValidShellTheme(e.newValue)) {
        setTheme(e.newValue)
      }
    }
    const onPageShow = () => setTheme(readShellTheme())
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onPreference = () => setPrefersDark(mq.matches)
    window.addEventListener('storage', onStorage)
    window.addEventListener('pageshow', onPageShow)
    mq.addEventListener('change', onPreference)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pageshow', onPageShow)
      mq.removeEventListener('change', onPreference)
    }
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        {screen === 'hub' ? (
          <motion.div
            key="hub"
            className="min-h-full flex flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <Hub t={t} lang={lang} setLang={setLang} theme={resolvedTheme} setTheme={setTheme} />
          </motion.div>
        ) : (
          <motion.div
            key="gate"
            className="min-h-full flex flex-col items-center gate-bg px-4 pt-16 pb-10 relative"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE } }}
            exit={{ opacity: 0, scale: 1.02, transition: { duration: 0.38, ease: EASE } }}
          >
            <div className="absolute top-5 right-5 flex items-center gap-2" style={{ zIndex: 'var(--z-chrome)' }}>
              <ThemeToggle theme={resolvedTheme} setTheme={setTheme} t={t} />
              <Segmented
                ariaLabel={t('language')}
                options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
                value={lang}
                onChange={setLang}
              />
            </div>

            {/* The halo — the door's only state, so it is simply on. */}
            <div aria-hidden className="gate-halo absolute inset-0 pointer-events-none" />

            <div className="relative my-auto w-full flex flex-col items-center min-w-0">
              <motion.div
                layout
                transition={SPRING}
                className="w-full rounded-(--r-card) vault-surface"
                style={{ maxWidth: 760 }}
              >
                <div className="flex flex-col">
                  <Welcome t={t} isWelcome onEnter={enterHub} />
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}
