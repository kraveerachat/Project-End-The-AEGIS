import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, FileText } from 'lucide-react'
import { fetchMe, logout as apiLogout } from './lib/auth.js'
import { registerUnauthorizedHandler } from './lib/api.js'
import { makeT } from './lib/strings.js'
import { useApi, useReducedMotion } from './lib/hooks.js'
import { HatchDefs, SkeletonLoader } from './components/ui.jsx'
import { Sidebar } from './components/Sidebar.jsx'
import { TopBar } from './components/TopBar.jsx'
import { Login } from './screens/Login.jsx'
import { Dashboard } from './screens/Dashboard.jsx'
import { Files } from './screens/Files.jsx'
import { Vault } from './screens/Vault.jsx'
import { Uploads } from './screens/Uploads.jsx'
import { Shares } from './screens/Shares.jsx'
import { Snapshots } from './screens/Snapshots.jsx'
import { Storage } from './screens/Storage.jsx'
import { Audit } from './screens/Audit.jsx'
import { Access } from './screens/Access.jsx'
import { Settings } from './screens/Settings.jsx'

const TITLE_KEYS = {
  dashboard: 'dashTitle', files: 'filesTitle', vault: 'vaultTitle', uploads: 'uploadsTitle',
  shares: 'sharesTitle', snapshots: 'snapshotsTitle', storage: 'storageTitle',
  audit: 'auditTitle', access: 'accessTitle', settings: 'settingsTitle',
}

export default function App() {
  // ── Session — หน่วยความจำเท่านั้น ────────────────────────────────
  // session จริงอยู่ใน HttpOnly + Secure + SameSite=Strict cookie ("aegis.drive.sid")
  // ที่ JavaScript อ่านไม่ได้ — ต่อให้เกิด XSS ก็ขโมย session ไม่ได้
  // ฝั่ง client เก็บได้แค่ "สำเนาที่เซิร์ฟเวอร์ตัดสินมา" ใน React state:
  // null = ยังไม่ล็อกอิน · { username, role, displayName, menu } = คำตอบจาก /api/me
  // ไม่มี localStorage/sessionStorage ที่ไหนเลย: ปิดแท็บ = state หาย, cookie ยังอยู่
  const [session, setSession] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  // ตรวจเซสชันเดิมตอนเปิดแอป — cookie (HttpOnly) แนบไปเอง; server ตอบ user+menu
  useEffect(() => {
    let alive = true
    fetchMe().then((me) => {
      if (!alive) return
      if (me) setSession({ ...me.user, menu: me.menu })
      setAuthChecked(true)
    })
    return () => { alive = false }
  }, [])

  // เซสชันหมดอายุกลางคัน (401 จาก endpoint ใดก็ตาม) → กลับประตูทันที ไม่ค้างจอ
  useEffect(() => {
    registerUnauthorizedHandler(() => setSession(null))
  }, [])

  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  const [theme, setTheme] = useState('light')
  const [density, setDensity] = useState('comfortable')
  const [screen, setScreen] = useState('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  // ตัวเลขรวมของแอป (มิเตอร์ใน Sidebar) — จากเซิร์ฟเวอร์เท่านั้น, poll เงียบ ๆ ทุก 30s
  const dashApi = useApi(session ? '/api/dashboard' : null, { refreshMs: 30_000 })
  const metrics = dashApi.data?.metrics ?? null

  // ดัชนีไฟล์สำหรับช่องค้นหา — ชุดเดียวกับจอ Files (ไม่มี fixture ฝั่ง client แล้ว)
  const filesApi = useApi(session ? '/api/files' : null, { refreshMs: 60_000 })

  // Search state
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef(null)

  // ⚠️ ไม่มี preview-as-role / role switcher ใด ๆ — role มาจากเซิร์ฟเวอร์เท่านั้น
  // การเดโม่สองบทบาทใช้ "สองบัญชีจริง" ล็อกอินสลับกัน (ดู server/db/seed.sql)
  // switcher ฝั่ง client จะขัดแย้งกับข้อโต้แย้งด้านความปลอดภัยของระบบเอง
  const effectiveRole = session?.role ?? null

  const t = useMemo(() => makeT(lang), [lang])
  const reduced = useReducedMotion()
  const mainRef = useRef(null)

  // เมนูถูก filter ตาม role "ฝั่งเซิร์ฟเวอร์" มาแล้ว (server/rbac/permissions.js)
  // — client แค่ render สิ่งที่ได้รับ รายการที่ไม่มีสิทธิ์ไม่เคยมาถึง DOM เลย
  const nav = session?.menu ?? []

  // ⌘K / Ctrl+K listener
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // theme: light | dark | system → data-theme on <html>
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.documentElement.classList.toggle('dark', dark)

      const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
      link.type = 'image/png'
      link.rel = 'shortcut icon'
      link.href = import.meta.env.BASE_URL + (dark ? 'assets/logo/aegis-mark-dark-ink.png' : 'assets/logo/aegis-mark-light-ink.png')
      if (!link.parentNode) document.getElementsByTagName('head')[0].appendChild(link)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // language switch: cross-fade in place — never blank-and-repaint
  const firstLang = useRef(true)
  useEffect(() => {
    if (firstLang.current) { firstLang.current = false; return }
    if (reduced || !mainRef.current) return
    mainRef.current.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 250, easing: 'ease-out' })
  }, [lang, reduced])

  // if the previewed role loses the current screen, leave it
  useEffect(() => {
    if (!session) return
    const allowed = new Set([...nav.map((n) => n.id), 'settings'])
    if (!allowed.has(screen)) setScreen('dashboard')
  }, [nav, screen, session])

  // Screen transition loading states (shimmer/pulse)
  const [loadingScreen, setLoadingScreen] = useState(null)
  const prevScreen = useRef(screen)
  useEffect(() => {
    if (!session) return
    if (prevScreen.current !== screen) {
      setLoadingScreen(screen)
      const delay = reduced ? 0 : 400
      const timer = setTimeout(() => {
        setLoadingScreen(null)
      }, delay)
      prevScreen.current = screen
      return () => clearTimeout(timer)
    }
  }, [screen, session, reduced])

  const getSkeletonType = (scr) => {
    if (scr === 'dashboard') return 'dashboard'
    if (scr === 'files') return 'files'
    if (['shares', 'snapshots', 'storage', 'audit', 'access'].includes(scr)) return 'table'
    return 'generic'
  }

  const matches = (filesApi.data?.files ?? [])
    .filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 5)

  const screenEl = {
    dashboard: <Dashboard t={t} lang={lang} />,
    files: <Files t={t} lang={lang} go={setScreen} />,
    vault: <Vault t={t} />,
    uploads: <Uploads t={t} lang={lang} />,
    shares: <Shares t={t} />,
    snapshots: <Snapshots t={t} lang={lang} />,
    storage: <Storage t={t} />,
    audit: <Audit t={t} />,
    access: <Access t={t} />,
    settings: (
      <Settings
        t={t} lang={lang} setLang={setLang}
        theme={theme} setTheme={setTheme}
        density={density} setDensity={setDensity}
        role={effectiveRole} user={session}
      />
    ),
  }[screen]

  // ยังตรวจเซสชันกับเซิร์ฟเวอร์ไม่เสร็จ — อย่าเพิ่งแสดง Login กันหน้ากระพริบ
  if (!authChecked) {
    return <div className="h-full bg-canvas" aria-busy="true" />
  }

  // ไม่มีเซสชัน → ประตูของ Drive เอง (identity ของ Drive แยกขาดจากแอปอื่นทั้งหมด)
  if (!session) {
    return (
      <Login
        t={t}
        lang={lang}
        setLang={setLang}
        theme={theme}
        setTheme={setTheme}
        onAuthed={({ user, menu }) => {
          // role + เมนู (filter ตาม role แล้ว) มาจากคำตอบของเซิร์ฟเวอร์เท่านั้น
          setSession({ ...user, menu })
          setScreen('dashboard')
        }}
      />
    )
  }

  return (
    <div className="h-full flex bg-canvas">
      <HatchDefs />
      <Sidebar
        t={t}
        nav={nav}
        screen={screen}
        setScreen={setScreen}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        metrics={metrics}
        mobileOpen={mobileNav}
        closeMobile={() => setMobileNav(false)}
      />
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <TopBar
          t={t}
          scrolled={scrolled}
          user={session}
          onSignOut={() => {
            // ทำลายเซสชัน "ฝั่งเซิร์ฟเวอร์" (POST /api/logout) แล้วกลับสู่ประตูของ Drive
            // fire-and-forget: ต่อให้ request ล้ม client ก็ถือว่าออกแล้ว (state ถูกล้าง)
            apiLogout()
            setSession(null)
            setScreen('dashboard')
          }}
          openMobileNav={() => setMobileNav(true)}
        />
        <main
          ref={mainRef}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
          className="flex-1 overflow-y-auto"
        >
          <div key={screen} className="px-8 py-7 max-md:px-4 max-md:py-5 max-w-[1440px] mx-auto">
            {/* Page Header: Breadcrumbs + Title + Relocated Search Bar */}
            <div className="flex flex-col gap-2 mb-8 rise-in">
              <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs font-mono font-medium tracking-wider text-slate-400 dark:text-slate-500 uppercase select-none">
                <span>AEGIS</span>
                <span className="opacity-40">/</span>
                <span className="font-semibold text-blue-600 dark:text-blue-400">{t(TITLE_KEYS[screen])}</span>
              </nav>

              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                  {t(TITLE_KEYS[screen])}
                </h1>

                {/* Relocated Global Search Bar */}
                <div className="relative w-full max-w-[380px]">
                  <Search size={15} strokeWidth={1.5} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setSearchOpen(true) }}
                    onFocus={() => setSearchOpen(true)}
                    placeholder={t('searchPlaceholder')}
                    aria-label={t('searchPlaceholder')}
                    className="w-full h-10 pl-10 pr-12 rounded-full bg-sunken border border-line text-sm text-ink placeholder:text-ink-3 outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent-soft shadow-xs"
                  />
                  <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10.5px] font-mono font-medium text-ink-3 bg-card border border-line rounded px-1.5 py-0.5 pointer-events-none max-sm:hidden">
                    ⌘K
                  </kbd>
                  {searchOpen && (
                    <div className="absolute top-[calc(100%+6px)] right-0 w-full bg-card border border-line rounded-xl py-2 shadow-xl z-50">
                      <p className="px-4 pb-1.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">{t('searchRecent')}</p>
                      {matches.length === 0 && <p className="px-4 py-2 text-xs text-ink-3">{t('empty')}</p>}
                      {matches.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => { setSearchOpen(false); setQuery(''); setScreen('files') }}
                          className="w-full flex items-center gap-2.5 px-4 h-9 text-xs font-medium text-ink-2 hover:bg-sunken transition-colors cursor-pointer text-left"
                        >
                          <FileText size={14} className="text-ink-3 shrink-0" />
                          <span className="truncate">{f.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {loadingScreen ? (
              <SkeletonLoader type={getSkeletonType(loadingScreen)} />
            ) : (
              <div className="fade-in">{screenEl}</div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
