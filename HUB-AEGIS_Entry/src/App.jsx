import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Welcome } from './screens/Welcome.jsx'
import { Login } from './screens/Login.jsx'
import { Hub } from './screens/Hub.jsx'
import { Segmented, ThemeToggle } from './components/ui.jsx'
import { LANGS, makeT } from './lib/strings.js'
import { EASE, SPRING } from './lib/motion.js'

/**
 * AEGIS Entry Point Hub — a door, a lock, and a menu. Three screens,
 * one state machine, no routing library.
 *
 * Welcome and Login share ONE vault card: compact and centered at the
 * door, it springs open into a split card (brand left, lock right;
 * stacked below `md`) when the user enters. framer-motion `layout`
 * owns the expansion; `MotionConfig reducedMotion="user"` collapses
 * every transform for prefers-reduced-motion.
 *
 * The gate is full-bleed (`.gate-bg`): BG_AEGIS01/02 swap on theme and
 * their fibre streaks converge on an empty centre — the vault sits in
 * that void and expands into the incoming light. The Hub does NOT get
 * the photograph: the door is atmospheric, the workspace is plain.
 */
export default function App() {
  // ── Session — หน่วยความจำเท่านั้น ────────────────────────────────
  // จงใจ "ไม่มี" localStorage/sessionStorage ทั้งแอป: ปิดแท็บ = เซสชันหาย
  // ไม่มีอะไรตกค้างในเครื่อง ระบบจริง session อยู่ใน HttpOnly + Secure +
  // SameSite=Strict cookie ที่ JavaScript อ่านไม่ได้ — ต่อให้เกิด XSS
  // ก็ขโมย session ไปไม่ได้ (นี่คือเหตุผลที่ห้ามเก็บ token ใน storage)
  const [session, setSession] = useState(null) // null | { username, role, displayName }
  const [screen, setScreen] = useState('welcome') // 'welcome' | 'login' | 'hub'
  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  // Theme — React state เท่านั้น ห้าม localStorage/sessionStorage เด็ดขาด
  // (ข้อบังคับของโปรเจกต์: สองอย่างนี้ต้องไม่ปรากฏที่ไหนเลยใน codebase —
  // ในสภาพแวดล้อมนี้มันจะ throw และการเก็บ state ฝั่ง client คือนิสัยที่
  // นำไปสู่การเก็บของอันตรายกว่า เช่น token) ระบบจริงเก็บ preference นี้
  // ฝั่งเซิร์ฟเวอร์ผูกกับบัญชีผู้ใช้
  const [theme, setTheme] = useState('light')

  const t = makeT(lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const isWelcome = screen === 'welcome'

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        {screen === 'hub' && session ? (
          <motion.div
            key="hub"
            className="min-h-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <Hub
              t={t}
              lang={lang}
              setLang={setLang}
              session={session}
              theme={theme}
              setTheme={setTheme}
              onLogout={() => {
                // ออกจากระบบ = เซสชันหายทันที กลับไปที่ "ประตู"
                setSession(null)
                setScreen('welcome')
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="gate"
            className="min-h-full flex flex-col items-center gate-bg px-4 pt-24 pb-10 relative"
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

            <div className="my-auto w-full flex flex-col items-center min-w-0">
              {/* the vault — one borderless card, two states. maxWidth flips
                  per state and the layout spring makes the expansion the
                  signature gesture of the whole app. */}
              <motion.div
                layout
                transition={SPRING}
                className="w-full overflow-hidden bg-card rounded-(--r-card)"
                style={{ boxShadow: 'var(--elev-2)', maxWidth: isWelcome ? 480 : 944 }}
              >
                <div className={`flex flex-col ${isWelcome ? '' : 'md:flex-row md:items-stretch'}`}>
                  <Welcome t={t} isWelcome={isWelcome} onEnter={() => setScreen('login')} />
                  <AnimatePresence initial={false}>
                    {!isWelcome && (
                      <Login
                        key="login"
                        t={t}
                        onAuthed={(user) => {
                          // role มาใน response ของเซิร์ฟเวอร์เท่านั้น — client แค่อ่านและ render
                          setSession(user)
                          setScreen('hub')
                        }}
                      />
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>

              {/* demo aid for the presentation — clearly marked, not part of the product */}
              <AnimatePresence initial={false}>
                {!isWelcome && (
                  <motion.p
                    layout
                    key="demo"
                    className="mt-6 text-[12px] text-ink-3"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { delay: 0.4, duration: 0.3, ease: EASE } }}
                    exit={{ opacity: 0, transition: { duration: 0.15, ease: EASE } }}
                  >
                    demo · <span className="font-mono">user / aegis-user</span> · <span className="font-mono">admin / aegis-admin</span>
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}
