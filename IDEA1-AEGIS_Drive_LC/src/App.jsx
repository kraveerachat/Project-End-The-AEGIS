import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchMe, logout as apiLogout } from './lib/auth.js'
import { apiFetch, registerUnauthorizedHandler } from './lib/api.js'
import { makeT } from './lib/strings.js'
import { useApi, useReducedMotion } from './lib/hooks.js'
import { isPlatformWired } from './lib/fetchState.js'
import { buildLocationForIntent, normalizeNavigationIntent, readLocationIntent, visiblePrimaryNav } from './lib/navigationIntent.js'
import { HatchDefs, SkeletonLoader } from './components/ui.jsx'
import { Sidebar } from './components/Sidebar.jsx'
import { TopBar } from './components/TopBar.jsx'
import { GlobalSearch } from './components/GlobalSearch.jsx'
import { DashboardQuickActions } from './components/DashboardQuickActions.jsx'
import { themeAssetsFor } from './components/AegisMark.jsx'
import {
  applyThemeToDocument, readShellTheme, readStoredShellTheme,
  resolveAuthenticatedTheme, resolveTheme, writeShellTheme,
} from './lib/theme.js'
import {
  applyAuthenticatedInterfaceStyle,
  clearAuthenticatedInterfaceStyle,
} from './lib/interfaceStyle.js'
import { Login } from './screens/Login.jsx'
import { MandatoryPasswordReset } from './screens/MandatoryPasswordReset.jsx'

const lazyNamed = (loader, name) => lazy(() => loader().then((module) => ({ default: module[name] })))
const Dashboard = lazyNamed(() => import('./screens/Dashboard.jsx'), 'Dashboard')
const Files = lazyNamed(() => import('./screens/Files.jsx'), 'Files')
const Vault = lazyNamed(() => import('./screens/Vault.jsx'), 'Vault')
const Shares = lazyNamed(() => import('./screens/Shares.jsx'), 'Shares')
const FileHistory = lazyNamed(() => import('./screens/FileHistory.jsx'), 'FileHistory')
const Storage = lazyNamed(() => import('./screens/Storage.jsx'), 'Storage')
const Audit = lazyNamed(() => import('./screens/Audit.jsx'), 'Audit')
const Access = lazyNamed(() => import('./screens/Access.jsx'), 'Access')
const Settings = lazyNamed(() => import('./screens/Settings.jsx'), 'Settings')

const TITLE_KEYS = {
  dashboard: 'dashTitle', files: 'filesTitle', vault: 'vaultTitle',
  shares: 'sharesTitle', versions: 'versionsTitle', storage: 'storageTitle',
  audit: 'auditTitle', access: 'accessTitle', settings: 'settingsTitle',
}

/* ── Context search: ขอบเขตเปลี่ยนตามงานของจอ ─────────────────────────────
   Files และ Access มีตัวกรองรายการของตัวเองอยู่แล้ว จึงไม่วางช่องซ้ำใน page
   header ส่วน Dashboard ใช้ global index และจอประวัติ/แชร์ใช้เฉพาะ file index
   (ดู SEARCH_SCOPE_BY_SCREEN ใน GlobalSearch.jsx)

   VAULT คือข้อยกเว้นเดียว — ปิดการใช้งาน (เทา ๆ ไม่ใช่ซ่อน) พร้อมทูลทิปบอกเหตุผล
   เพราะเนื้อหาถูกเข้ารหัสแบบ zero-knowledge: เซิร์ฟเวอร์เก็บแต่ ciphertext และ
   ชื่อไฟล์ที่ถอดรหัสแล้วอยู่ใน state ของจอ Vault เท่านั้น ไม่เคยขึ้นมาถึง App
   จึงไม่มีทาง index ได้ — การ disable คือการบอกความจริงข้อนี้ ไม่ใช่การกันเชิงสิทธิ์ */
const SEARCH_DISABLED_SCREENS = new Set(['vault'])
const HEADER_SEARCH_HIDDEN_SCREENS = new Set(['files', 'access'])

export default function App() {
  // ── Session — หน่วยความจำเท่านั้น ────────────────────────────────
  // session จริงอยู่ใน HttpOnly + Secure + SameSite=Strict cookie ("aegis.drive.sid")
  // ที่ JavaScript อ่านไม่ได้ — ต่อให้เกิด XSS ก็ขโมย session ไม่ได้
  // ฝั่ง client เก็บได้แค่ "สำเนาที่เซิร์ฟเวอร์ตัดสินมา" ใน React state:
  // null = ยังไม่ล็อกอิน · { username, role, displayName, menu } = คำตอบจาก /api/me
  // ข้อมูล session ไม่ลง localStorage/sessionStorage: ปิดแท็บ = state หาย, cookie ยังอยู่
  // localStorage เก็บเฉพาะ shell theme (light/dark/system) เพื่อกันหน้ากระพริบ
  const [session, setSession] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  // เซสชันหมดอายุกลางคัน (401 จาก endpoint ใดก็ตาม) → กลับประตูทันที ไม่ค้างจอ
  useEffect(() => {
    registerUnauthorizedHandler(() => {
      clearAuthenticatedInterfaceStyle()
      setSession(null)
    })
  }, [])

  const [lang, setLang] = useState('th') // Thai-first (PRODUCT.md)
  const [theme, setTheme] = useState(() => readShellTheme())
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(
    readShellTheme(),
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  ))
  const [density, setDensity] = useState('comfortable')
  const [interfaceStyle, setInterfaceStyle] = useState('classic')
  const [preferenceSaving, setPreferenceSaving] = useState(false)
  const [preferenceError, setPreferenceError] = useState(false)
  const [settingsTab, setSettingsTab] = useState('appearance')
  const [screen, setScreen] = useState(() => (
    typeof window === 'undefined'
      ? 'dashboard'
      : readLocationIntent(window.location.pathname, window.location.search, import.meta.env.BASE_URL).screen
  ))
  const [navigationParams, setNavigationParams] = useState(() => (
    typeof window === 'undefined'
      ? {}
      : readLocationIntent(window.location.pathname, window.location.search, import.meta.env.BASE_URL).params
  ))
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  // ── สัญญาธีมข้ามด่านล็อกอิน (ดู resolveAuthenticatedTheme ใน lib/theme.js) ────────
  //
  // "ผู้ใช้เพิ่งเลือกธีมเองบนหน้า Login ในเซสชันที่ยังไม่ล็อกอินนี้หรือยัง" — เก็บใน ref
  // ไม่ใช่ state เพราะมันไม่ใช่สิ่งที่ต้อง render และไม่ใช่สิ่งที่ควรค้างข้ามการโหลดหน้า:
  // มันมีอายุแค่ "ตั้งแต่ผู้ใช้กดปุ่มธีม จนถึงตอนล็อกอินสำเร็จ" ครั้งเดียวแล้วถูกล้างทิ้ง
  // (shell hint ใน localStorage ยังถูกเขียนตามปกติ — ที่นี่เก็บแค่ "ความตั้งใจที่เพิ่งเกิด")
  const loginThemeSelection = useRef(null)
  // ส่งต่อธีมตอน logout ได้หนึ่งครั้งและเฉพาะ user id เดิมเท่านั้น เก็บในหน่วยความจำ
  // จึงไม่ทิ้ง identity/role/token/session ใด ๆ ไว้ใน browser storage และหายเมื่อ reload
  const logoutThemeContinuity = useRef(null)

  const prefersDarkNow = () => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  /**
   * ใช้ธีมนี้ "เดี๋ยวนี้" — เขียน DOM ทันทีแบบ synchronous ก่อนคืนไปให้ React re-render
   *
   * ⚠️ การเขียน DOM ตรงนี้ไม่ใช่ของซ้ำซ้อนกับ effect ด้านล่าง แต่คือสิ่งที่กันหน้ากระพริบ:
   *    effect ของธีมทำงาน "หลัง" React commit จอใหม่ ถ้ารอมัน เฟรมแรกของ Dashboard จะถูก
   *    วาดด้วยธีมเก่าก่อนแล้วค่อยสลับ = แฟลชขาวที่ผู้ใช้เห็นจริง effect จึงเหลือหน้าที่แค่
   *    ตามการเปลี่ยนของ OS (system) และอัปเดต favicon เท่านั้น
   */
  const adoptTheme = useCallback((next) => {
    setTheme(next)
    writeShellTheme(next)
    setResolvedTheme(applyThemeToDocument(next, { prefersDark: prefersDarkNow() }))
  }, [])

  /** ผู้ใช้กดเลือกธีมเองบนหน้า Login — บันทึกเจตนาไว้ให้ด่านล็อกอินใช้ */
  const selectLoginTheme = useCallback((next) => {
    loginThemeSelection.current = next
    adoptTheme(next)
  }, [adoptTheme])

  /** ดัน ui_theme ขึ้นบัญชีให้ตรงกับที่ตาเห็น — ยิงเฉพาะตอนค่ามันต่างกันจริงเท่านั้น */
  const persistThemeToAccount = useCallback(async (nextTheme, preferences) => {
    const result = await apiFetch('/api/preferences', {
      method: 'PATCH',
      body: {
        theme: nextTheme,
        language: preferences?.language ?? 'th',
        density: preferences?.density ?? 'comfortable',
        interfaceStyle: preferences?.interfaceStyle ?? 'classic',
      },
    })
    // บันทึกไม่ผ่าน = ธีมที่ตาเห็นยังถูกต้องสำหรับเบราว์เซอร์นี้ (shell hint เขียนไปแล้ว)
    // แต่จอ Settings ต้องพูดความจริงว่าค่าฝั่งบัญชียังไม่ถูกบันทึก
    if (!result.ok) return setPreferenceError(true)
    setSession((current) => (current ? { ...current, preferences: result.data.preferences } : current))
  }, [])

  /**
   * ด่านเดียวที่ unauthenticated → authenticated เดินผ่าน (ทั้งล็อกอินใหม่และกู้เซสชันเดิม)
   * ธีมถูกตัดสินที่นี่จุดเดียว — ไม่มี component ไหนตั้งธีมหลังล็อกอินแข่งกับที่นี่อีก
   */
  const applyAuthenticatedSession = useCallback(({ user, menu }) => {
    const continuity = logoutThemeContinuity.current
    logoutThemeContinuity.current = null // one-shot: การล็อกอินครั้งถัดไปใช้หรือทิ้งทันที
    const decision = resolveAuthenticatedTheme({
      selection: loginThemeSelection.current,
      logoutTheme: continuity && String(continuity.userId) === String(user.id)
        ? continuity.theme
        : null,
      accountTheme: user.preferences?.theme,
      shellTheme: readStoredShellTheme(),
    })
    loginThemeSelection.current = null // เจตนาถูกใช้ไปแล้ว — ไม่ค้างไปถึงการล็อกอินครั้งหน้า

    const nextInterfaceStyle = applyAuthenticatedInterfaceStyle(user.preferences?.interfaceStyle)
    setInterfaceStyle(nextInterfaceStyle)
    setSession({ ...user, menu })
    setLang(user.preferences?.language ?? 'th')
    setDensity(user.preferences?.density ?? 'comfortable')
    adoptTheme(decision.theme)
    // หลังจุดนี้: users.ui_theme = shell hint = ธีมที่ render จริง (ไม่เหลือค่าที่ขัดกัน)
    if (decision.persistToAccount) persistThemeToAccount(decision.theme, user.preferences)
  }, [adoptTheme, persistThemeToAccount])

  // ตรวจเซสชันเดิมตอนเปิดแอป — cookie (HttpOnly) แนบไปเอง; server ตอบ user+menu
  useEffect(() => {
    let alive = true
    fetchMe().then((me) => {
      if (!alive) return
      if (me) applyAuthenticatedSession(me)
      setAuthChecked(true)
    })
    return () => { alive = false }
  }, [applyAuthenticatedSession])

  // บัญชีที่ยังใช้รหัสชั่วคราวไม่มีสิทธิ์อ่าน protected endpoint ใด ๆ:
  // ส่ง null ให้ทุก hook เพื่อหยุดทั้ง request แรกและ polling 403 จนรีเซ็ตรหัสสำเร็จ
  const protectedDataEnabled = Boolean(session && !session.mustResetPassword)

  // ตัวเลขรวมของแอป (มิเตอร์ใน Sidebar) — จากเซิร์ฟเวอร์เท่านั้น, poll เงียบ ๆ ทุก 30s
  const dashApi = useApi(protectedDataEnabled ? '/api/dashboard' : null, { refreshMs: 30_000 })
  const metrics = dashApi.data?.metrics ?? null
  const healthApi = useApi(protectedDataEnabled ? '/healthz' : null, { refreshMs: 15_000 })
  // Server Telemetry — polled only while the Dashboard is the visible screen,
  // because that is the only place the tiles render.
  // Cadence: the host agent samples about every 5s and Drive marks a host
  // measurement stale after 15s, so 10s picks up every second sample at worst
  // and still leaves room for one missed agent cycle before the tiles say
  // "Stale". Anything faster re-fetches snapshots the agent has not recomputed.
  const telemetryApi = useApi(
    protectedDataEnabled && screen === 'dashboard' ? '/api/telemetry' : null,
    { refreshMs: 10_000 },
  )
  // The in-memory fallback is seeded for development. Treat it as an unwired
  // backend on data screens so fixture rows never masquerade as NAS content.
  const placeholderMode = !isPlatformWired(healthApi.data)

  // ⚠️ ไม่มี preview-as-role / role switcher ใด ๆ — role มาจากเซิร์ฟเวอร์เท่านั้น
  // การเดโม่สองบทบาทใช้ "สองบัญชีจริง" ล็อกอินสลับกัน (ดู server/db/seed.sql)
  // switcher ฝั่ง client จะขัดแย้งกับข้อโต้แย้งด้านความปลอดภัยของระบบเอง
  const effectiveRole = session?.role ?? null

  const t = useMemo(() => makeT(lang), [lang])
  const reduced = useReducedMotion()
  const mainRef = useRef(null)

  // เมนูถูก filter ตาม role "ฝั่งเซิร์ฟเวอร์" มาแล้ว (server/rbac/permissions.js)
  // — client แค่ render สิ่งที่ได้รับ รายการที่ไม่มีสิทธิ์ไม่เคยมาถึง DOM เลย
  const serverNav = session?.menu ?? []
  // The server remains the RBAC authority. The client only removes the legacy
  // Upload destination because upload is now a workflow inside Files.
  const nav = useMemo(() => visiblePrimaryNav(serverNav), [serverNav])

  const go = useCallback((destination, params = {}, options = {}) => {
    const intent = normalizeNavigationIntent(destination, params)
    setScreen(intent.screen)
    setNavigationParams(intent.params)
    if (typeof window !== 'undefined') {
      const nextLocation = buildLocationForIntent(intent, import.meta.env.BASE_URL)
      const method = options.replace ? 'replaceState' : 'pushState'
      window.history[method](null, '', nextLocation)
    }
  }, [])

  useEffect(() => {
    const onPopState = () => {
      const intent = readLocationIntent(window.location.pathname, window.location.search, import.meta.env.BASE_URL)
      setScreen(intent.screen)
      setNavigationParams(intent.params)
    }
    window.addEventListener('popstate', onPopState)
    const initialIntent = readLocationIntent(window.location.pathname, window.location.search, import.meta.env.BASE_URL)
    const canonicalLocation = buildLocationForIntent(initialIntent, import.meta.env.BASE_URL)
    if (`${window.location.pathname}${window.location.search}` !== canonicalLocation) {
      window.history.replaceState(null, '', canonicalLocation)
    }
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // ── ดัชนีสำหรับ GlobalSearch — fetch ที่นี่ตัวเดียว (คงที่ข้ามการเปลี่ยนจอ)
  // ส่วน "เปิด/ปิด dropdown" เป็นของ GlobalSearch เองล้วน ๆ ไม่ยกขึ้นมาที่นี่
  const filesApi = useApi(protectedDataEnabled ? '/api/files' : null, { refreshMs: 60_000 })
  // กลุ่ม PEOPLE โผล่เฉพาะคนที่เซิร์ฟเวอร์ให้เห็นจอ Access อยู่แล้ว —
  // ใช้เมนูที่ถูก filter มาจากเซิร์ฟเวอร์เป็นตัวตัดสิน ไม่เดา role ฝั่ง client
  const canSeePeople = nav.some((n) => n.id === 'access')
  const usersApi = useApi(protectedDataEnabled && canSeePeople ? '/api/users' : null, { refreshMs: 60_000 })

  // theme: light | dark | system → data-theme on <html>
  // ⚠️ effect นี้ "ตาม" การเปลี่ยนธีม ไม่ใช่ตัวที่ทำให้ธีมเปลี่ยน — adoptTheme() เขียน DOM
  //    ไปก่อนแล้วแบบ synchronous สิ่งที่เหลือให้ที่นี่ทำคือฟังการเปลี่ยนของ OS (system) และ
  //    อัปเดต favicon ให้ตรงธีม การเรียก apply() ซ้ำเป็น idempotent จึงไม่มีการแข่งกันเขียน
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const nextResolvedTheme = applyThemeToDocument(theme, { prefersDark: mq.matches })
      setResolvedTheme(nextResolvedTheme)
      const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
      link.type = 'image/png'
      link.rel = 'shortcut icon'
      link.href = import.meta.env.BASE_URL + themeAssetsFor(nextResolvedTheme).logo
      if (!link.parentNode) document.getElementsByTagName('head')[0].appendChild(link)
    }
    writeShellTheme(theme)
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
    if (!allowed.has(screen)) go('dashboard', {}, { replace: true })
  }, [go, nav, screen, session])

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
    if (['shares', 'versions', 'storage', 'audit', 'access'].includes(scr)) return 'table'
    return 'generic'
  }

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
        resolvedTheme={resolvedTheme}
        setTheme={selectLoginTheme}
        // role + เมนู (filter ตาม role แล้ว) มาจากคำตอบของเซิร์ฟเวอร์เท่านั้น
        // ธีมของจอถัดไปตัดสินใน applyAuthenticatedSession() — ที่นี่ไม่ตั้งธีมเองเด็ดขาด
        onAuthed={applyAuthenticatedSession}
      />
    )
  }

  const signOut = () => {
    // เก็บเฉพาะ user id + presentation theme ในหน่วยความจำ เพื่อให้บัญชีเดิมกลับมาใช้
    // ธีมที่เพิ่งเห็นได้หนึ่งครั้ง บัญชีอื่นไม่เคยได้รับค่านี้
    logoutThemeContinuity.current = session?.id == null
      ? null
      : { userId: session.id, theme }
    // ทำลายเซสชันฝั่งเซิร์ฟเวอร์ แล้วล้างสำเนา session ในหน่วยความจำทันที
    apiLogout()
    clearAuthenticatedInterfaceStyle()
    setSession(null)
    // ⚠️ ธีมไม่ถูกรีเซ็ตตอนออกจากระบบโดยเจตนา — จอ Login ต้องรับช่วงธีมของแอปต่อทันที
    //    (App Dark → Logout → Login Dark) shell hint ถูกเขียนไว้แล้วตั้งแต่ตอนเลือกธีม
    loginThemeSelection.current = null // เริ่มเซสชัน Login ใหม่แบบ "ยังไม่มีการเลือกใหม่"
    go('dashboard', {}, { replace: true })
  }

  // ด่านนี้มาก่อนการสร้าง protected screen ทุกจอ: ไม่มี Sidebar/TopBar และไม่มี
  // data component ใดถูก mount จน backend ยืนยันว่าเลิกใช้รหัสผ่านชั่วคราวแล้ว
  if (session.mustResetPassword) {
    return (
      <MandatoryPasswordReset
        t={t}
        user={session}
        onSignOut={signOut}
        onReset={() => setSession((current) => (
          current ? { ...current, mustResetPassword: false } : current
        ))}
      />
    )
  }

  const updatePreference = async (key, value) => {
    const previous = { theme, language: lang, density, interfaceStyle }
    // ธีมเดินผ่าน adoptTheme() เสมอ (เขียน DOM + shell hint ทันที) — จอ Settings/TopBar
    // จึงใช้เส้นทางเดียวกับด่านล็อกอิน ไม่มีเส้นทางที่สองที่เขียนธีมด้วยกฎของตัวเอง
    const setValue = {
      theme: adoptTheme,
      language: setLang,
      density: setDensity,
    }[key]
    setValue(value)
    setPreferenceSaving(true)
    setPreferenceError(false)
    const next = { ...previous, [key]: value }
    const result = await apiFetch('/api/preferences', { method: 'PATCH', body: next })
    setPreferenceSaving(false)
    if (!result.ok) {
      // Keep the user's visual choice active for this browser session. A
      // persistence outage must not make theme controls (or theme-aware brand
      // assets) visibly snap back; Settings still reports that saving failed.
      setPreferenceError(true)
      return
    }
    setSession((current) => current ? { ...current, preferences: result.data.preferences } : current)
  }

  const switchInterfaceStyle = async (value) => {
    if (value === interfaceStyle) return true
    setPreferenceSaving(true)
    setPreferenceError(false)
    const next = { theme, language: lang, density, interfaceStyle: value }
    const result = await apiFetch('/api/preferences', { method: 'PATCH', body: next })
    if (!result.ok) {
      setPreferenceSaving(false)
      setPreferenceError(true)
      return false
    }

    // The active shell deliberately keeps its current style until it is unmounted.
    // This avoids a half-Classic/half-Neo frame between persistence and logout.
    setSession((current) => current ? { ...current, preferences: result.data.preferences } : current)
    await apiLogout()
    clearAuthenticatedInterfaceStyle()
    setSession(null)
    setPreferenceSaving(false)
    setPreferenceError(false)
    setSettingsTab('appearance')
    setNavigationParams({})
    setCollapsed(false)
    setMobileNav(false)
    setScrolled(false)
    loginThemeSelection.current = null
    go('dashboard', {}, { replace: true })
    return true
  }

  const screenEl = {
    dashboard: (
      <Dashboard
        t={t}
        lang={lang}
        health={healthApi}
        go={go}
        telemetry={telemetryApi.data}
        // Passed so the tiles can tell "not read yet" from "read and failed".
        telemetryLoading={telemetryApi.loading}
      />
    ),
    files: <Files t={t} lang={lang} go={go} navigationParams={navigationParams} placeholderMode={placeholderMode} />,
    vault: <Vault t={t} lang={lang} placeholderMode={placeholderMode} />,
    shares: <Shares t={t} initialFileId={navigationParams.fileId} placeholderMode={placeholderMode} />,
    versions: <FileHistory t={t} lang={lang} initialFileId={navigationParams.fileId} placeholderMode={placeholderMode} />,
    storage: <Storage t={t} go={go} placeholderMode={placeholderMode} />,
    audit: <Audit t={t} placeholderMode={placeholderMode} />,
    access: <Access t={t} user={session} placeholderMode={placeholderMode} />,
    settings: (
      <Settings
        t={t} lang={lang} setLang={(value) => updatePreference('language', value)}
        theme={theme} setTheme={(value) => updatePreference('theme', value)}
        density={density} setDensity={(value) => updatePreference('density', value)}
        interfaceStyle={interfaceStyle}
        onInterfaceStyleChange={switchInterfaceStyle}
        role={effectiveRole} user={session}
        initialTab={settingsTab}
        preferenceSaving={preferenceSaving}
        preferenceError={preferenceError}
        placeholderMode={placeholderMode}
        // ผู้ใช้แก้ชื่อโปรไฟล์ของตัวเอง → อัปเดต session state ทันทีเพื่อให้ TopBar/
        // จอทุกจอเห็นชื่อใหม่โดยไม่ต้องรีเฟรช (เซิร์ฟเวอร์อัปเดต session ของมันเองแล้ว)
        onProfileSaved={(u) => setSession((s) => (s ? { ...s, ...u } : s))}
      />
    ),
  }[screen]

  return (
    <div className="authenticated-shell h-full flex bg-canvas" data-interface-style={interfaceStyle}>
      <HatchDefs />
      <Sidebar
        t={t}
        nav={nav}
        screen={screen}
        setScreen={go}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        metrics={placeholderMode ? null : metrics}
        metricsUnavailable={placeholderMode}
        resolvedTheme={resolvedTheme}
        mobileOpen={mobileNav}
        closeMobile={() => setMobileNav(false)}
      />
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <TopBar
          t={t}
          lang={lang}
          scrolled={scrolled}
          user={session}
          health={healthApi}
          resolvedTheme={resolvedTheme}
          onThemeChange={(value) => updatePreference('theme', value)}
          onProfile={() => { setSettingsTab('account'); go('settings') }}
          onSettings={() => { setSettingsTab('appearance'); go('settings') }}
          onSignOut={signOut}
          openMobileNav={() => setMobileNav(true)}
        />
        <main
          ref={mainRef}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
          className="flex-1 overflow-y-auto"
        >
          <div key={screen} className="px-8 py-7 max-md:px-4 max-md:py-5 max-w-[1440px] mx-auto">
            {/* One composed header: breadcrumb + title on the left, search/actions on the right. */}
            <div className="dashboard-page-header flex flex-col gap-2 mb-6 rise-in">
              <nav aria-label={t('breadcrumb')} className="flex items-center gap-2 text-xs font-mono font-medium tracking-wider text-slate-400 dark:text-slate-500 uppercase select-none">
                <span>AEGIS</span>
                <span className="opacity-40">/</span>
                <span className="font-semibold text-blue-600 dark:text-blue-400">{t(TITLE_KEYS[screen])}</span>
              </nav>

              <div className="page-header-main flex items-center justify-between gap-5">
                <h1 className="shrink-0 text-2xl md:text-[28px] font-bold tracking-[-0.025em] text-ink">
                  {t(TITLE_KEYS[screen])}
                </h1>

                <div className="page-header-tools flex min-w-0 items-center justify-end gap-2.5">
                  {/* Context search — ไม่ render ซ้ำบน Files/Access ที่มี local filter
                      จอ Vault ได้ช่อง disabled เพื่อบอกข้อจำกัดตามจริง
                      ⚠️ ดัชนีที่ส่งเข้าไปมีแค่ files + users ที่เซิร์ฟเวอร์อนุญาตแล้ว —
                         ไม่มีข้อมูล vault อยู่ในนี้เลยไม่ว่าจออะไร */}
                  {!HEADER_SEARCH_HIDDEN_SCREENS.has(screen) && (
                    <GlobalSearch
                      t={t}
                      screen={screen}
                      go={go}
                      nav={nav}
                      files={filesApi.data?.files ?? []}
                      people={usersApi.data?.users ?? []}
                      disabled={SEARCH_DISABLED_SCREENS.has(screen)}
                      className="header-context-search"
                    />
                  )}
                  {screen === 'dashboard' && <DashboardQuickActions t={t} go={go} />}
                </div>
              </div>
            </div>
            {loadingScreen ? (
              <SkeletonLoader type={getSkeletonType(loadingScreen)} />
            ) : (
              <Suspense fallback={<SkeletonLoader type={getSkeletonType(screen)} />}>
                <div className="fade-in">{screenEl}</div>
              </Suspense>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
