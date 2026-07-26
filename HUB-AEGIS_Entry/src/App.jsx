import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Welcome } from './screens/Welcome.jsx'
import { Hub } from './screens/Hub.jsx'
import { Segmented, ThemeToggle } from './components/ui.jsx'
import { LANGS, makeT } from './lib/strings.js'
import { EASE, SPRING } from './lib/motion.js'

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
  const [screen, setScreen] = useState('welcome') // 'welcome' | 'hub'
  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('aegis_theme') || 'dark'
  })

  const t = makeT(lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    const dark = theme === 'dark'
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.classList.toggle('light', !dark)
    localStorage.setItem('aegis_theme', theme)

    const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
    link.type = 'image/png'
    link.rel = 'shortcut icon'
    link.href = theme === 'light' ? '/assets/logo/aegis-mark-light-ink.png' : '/assets/logo/aegis-mark-dark-ink.png'
    if (!link.parentNode) document.getElementsByTagName('head')[0].appendChild(link)
  }, [theme])

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'aegis_theme' && e.newValue) {
        setTheme(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
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
            <Hub t={t} lang={lang} setLang={setLang} theme={theme} setTheme={setTheme} />
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
              <ThemeToggle theme={theme} setTheme={setTheme} t={t} />
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
                  <Welcome t={t} isWelcome onEnter={() => setScreen('hub')} />
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}
