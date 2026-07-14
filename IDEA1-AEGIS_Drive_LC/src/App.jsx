import { useEffect, useMemo, useRef, useState } from 'react'
import { getNavForRole } from './lib/authz.js'
import { makeT } from './lib/strings.js'
import { useReducedMotion } from './lib/hooks.js'
import { HatchDefs } from './components/ui.jsx'
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
  // จงใจ "ไม่มี" localStorage/sessionStorage ทั้งแอป: ปิดแท็บ = เซสชันหาย
  // ไม่มีอะไรตกค้างในเครื่อง ระบบจริง session อยู่ใน HttpOnly + Secure +
  // SameSite=Strict cookie ที่ JavaScript อ่านไม่ได้ — ต่อให้เกิด XSS
  // ก็ขโมย session ไปไม่ได้ (นี่คือเหตุผลที่ห้ามเก็บ token ใน storage)
  const [session, setSession] = useState(null)

  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  const [theme, setTheme] = useState('light')
  const [density, setDensity] = useState('comfortable')
  const [screen, setScreen] = useState('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [metrics, setMetrics] = useState({ storageGB: 342, files: 12_847 })

  // Preview-as-role — เครื่องมือเดโมสำหรับผู้นำเสนอ "เท่านั้น" ไม่ใช่ส่วนของ auth
  // ค่าเริ่มต้นตาม role ที่เซิร์ฟเวอร์ตัดสินมา; ในระบบจริงต้องไม่มีปุ่มนี้ และ
  // backend ต้องตรวจสิทธิ์ทุก request อยู่ดี — สลับ preview ที่นี่ไม่ได้ทำให้
  // ข้อมูล admin รั่ว เพราะข้อมูลจริงต้องมาจาก API ที่ re-authorize เสมอ
  const [previewRole, setPreviewRole] = useState(null)
  const effectiveRole = previewRole ?? session?.role ?? null

  const t = useMemo(() => makeT(lang), [lang])
  const reduced = useReducedMotion()
  const mainRef = useRef(null)

  // nav ถูก filter ตาม role "ก่อน" render — default-deny (ดู lib/authz.js)
  const nav = getNavForRole(effectiveRole)

  // theme: light | dark | system → data-theme on <html>
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
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

  if (!session) {
    return (
      <>
        <HatchDefs />
        <Login
          t={t}
          lang={lang}
          setLang={setLang}
          theme={theme}
          setTheme={setTheme}
          onAuthed={(user) => {
            setSession(user)
            setPreviewRole(user.role) // server-decided; preview เริ่มที่ role จริง
            setScreen('dashboard')
            setScrolled(false)
          }}
        />
      </>
    )
  }

  const screenEl = {
    dashboard: <Dashboard t={t} metrics={metrics} />,
    files: <Files t={t} lang={lang} />,
    vault: <Vault t={t} />,
    uploads: (
      <Uploads
        t={t}
        onStorageAdded={(gb) =>
          setMetrics((m) => ({ storageGB: Math.round((m.storageGB + gb) * 10) / 10, files: m.files + 1 }))}
      />
    ),
    shares: <Shares t={t} />,
    snapshots: (
      <Snapshots
        t={t}
        lang={lang}
        onRollback={(lostGB) =>
          setMetrics((m) => ({
            storageGB: Math.max(0, Math.round((m.storageGB - lostGB) * 10) / 10),
            files: m.files - Math.round(lostGB * 37),
          }))}
      />
    ),
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
          screenLabel={t(TITLE_KEYS[screen])}
          scrolled={scrolled}
          previewRole={effectiveRole}
          setPreviewRole={setPreviewRole}
          user={session}
          theme={theme}
          setTheme={setTheme}
          onSignOut={() => { setSession(null); setPreviewRole(null) }}
          openMobileNav={() => setMobileNav(true)}
          goToFiles={() => setScreen('files')}
        />
        <main
          ref={mainRef}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
          className="flex-1 overflow-y-auto"
        >
          <div key={screen} className="px-8 py-7 max-md:px-4 max-md:py-5 max-w-[1440px] mx-auto">
            <h1 className="text-[30px] font-semibold tracking-[-0.02em] text-ink mb-6 rise-in">
              {t(TITLE_KEYS[screen])}
            </h1>
            {screenEl}
          </div>
        </main>
      </div>
    </div>
  )
}
