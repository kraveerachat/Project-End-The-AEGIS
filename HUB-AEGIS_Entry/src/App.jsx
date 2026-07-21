import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { Welcome } from './screens/Welcome.jsx'
import { Login } from './screens/Login.jsx'
import { Hub } from './screens/Hub.jsx'
import { Segmented, ThemeToggle } from './components/ui.jsx'
import { logout as apiLogout } from './lib/auth.js'
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
 * that void and expands into the incoming light.
 */
export default function App() {
  const [session, setSession] = useState(null) // null | { username, role, displayName, menu }
  const [screen, setScreen] = useState('welcome') // 'welcome' | 'login' | 'hub'
  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  const [theme, setTheme] = useState('dark')

  const t = makeT(lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    document.documentElement.dataset.theme = theme

    const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
    link.type = 'image/png'
    link.rel = 'shortcut icon'
    link.href = theme === 'light' ? '/assets/logo/aegis-mark-light-ink.png' : '/assets/logo/aegis-mark-dark-ink.png'
    if (!link.parentNode) document.getElementsByTagName('head')[0].appendChild(link)
  }, [theme])

  const isWelcome = screen === 'welcome'

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        {screen === 'hub' && session ? (
          <motion.div
            key="hub"
            className="min-h-full flex flex-col"
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
                apiLogout()
                setSession(null)
                setScreen('welcome')
              }}
            />
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

            {/* The halo — Welcome only. */}
            <motion.div
              aria-hidden
              className="gate-halo absolute inset-0 pointer-events-none"
              initial={false}
              animate={{ opacity: isWelcome ? 1 : 0 }}
              transition={{ duration: 0.5, ease: EASE }}
            />

            <div className="relative my-auto w-full flex flex-col items-center min-w-0">
              <motion.div
                layout
                transition={SPRING}
                className={`w-full rounded-(--r-card) vault-surface ${
                  isWelcome ? '' : 'is-solid overflow-hidden'
                }`}
                style={{ maxWidth: isWelcome ? 760 : 944 }}
              >
                <div className={`flex flex-col ${isWelcome ? '' : 'md:flex-row md:items-stretch'}`}>
                  <Welcome t={t} isWelcome={isWelcome} onEnter={() => setScreen('login')} />
                  <AnimatePresence initial={false}>
                    {!isWelcome && (
                      <Login
                        key="login"
                        t={t}
                        onAuthed={({ user, menu }) => {
                          setSession({ ...user, menu })
                          setScreen('hub')
                        }}
                      />
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>

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
