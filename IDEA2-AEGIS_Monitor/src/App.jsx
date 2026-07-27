import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar.jsx'
import Sidebar, { MobileNav } from './components/Sidebar.jsx'
import Footer from './components/Footer.jsx'
import Login from './screens/Login.jsx'
import Live from './views/Live.jsx'
import Archive from './views/Archive.jsx'
import Detection from './views/Detection.jsx'
import Alerts from './views/Alerts.jsx'
import Nodes from './views/Nodes.jsx'
import Operators from './views/Operators.jsx'
import Diagnostics from './views/Diagnostics.jsx'
import Settings from './views/Settings.jsx'
import { useMonitorEngine } from './engine.js'
import { fmtDate, fmtTime } from './data.js'
import { buildSections, viewOrderOf } from './nav.js'
import { fetchMe, fetchCameras, logout as apiLogout } from './lib/auth.js'
import { registerUnauthorizedHandler } from './lib/api.js'

export default function App() {
  // ── Session — หน่วยความจำเท่านั้น ──────────────────────────────────
  // session จริงอยู่ใน HttpOnly + SameSite=Strict cookie ("aegis.monitor.sid")
  // ที่ JS อ่านไม่ได้ — ฝั่ง client เก็บแค่ "สำเนาที่เซิร์ฟเวอร์ตัดสินมา":
  // null = ยังไม่ล็อกอิน · { username, role, displayName, menu } = คำตอบ /api/me
  // ⚠️ ไม่มี role switcher — เดโม่สองมุมมองใช้สองบัญชีจริง (soc / operator)
  const [session, setSession] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  // กล้องที่ "ผู้ใช้คนนี้" เห็นได้ — กรองผ่าน camera_assignment ฝั่งเซิร์ฟเวอร์แล้ว
  const [cameras, setCameras] = useState(null)

  const [view, setView] = useState('live')
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('aegis_theme') || 'dark'
  })
  const [lang, setLang] = useState('th')

  useEffect(() => {
    const dark = theme === 'dark'
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.classList.toggle('light', !dark)
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('aegis_theme', theme)

    const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
    link.type = 'image/png'
    link.rel = 'shortcut icon'
    link.href = import.meta.env.BASE_URL + (dark ? 'assets/logo/aegis-mark-dark-ink.png' : 'assets/logo/aegis-mark-light-ink.png')
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
  const [heroCam, setHeroCam] = useState(null)
  const [arcCam, setArcCam] = useState('all')
  const [arcResult, setArcResult] = useState('all')
  const [detCam, setDetCam] = useState('all')
  const [detResult, setDetResult] = useState('all')

  const menu = session?.menu ?? []
  const sections = buildSections(menu)
  const viewOrder = viewOrderOf(menu)
  // มีสิทธิ์เห็นวิวไหน ตัดสินจากเมนูของเซิร์ฟเวอร์เท่านั้น — วิวนอกเมนูไม่ถูก
  // render ลง DOM เลย (ไม่ใช่ซ่อนด้วย CSS) ดู server/rbac/permissions.js
  const has = (id) => menu.some((m) => m.id === id)

  // ⚠️ Phase 2: ข้อมูลสด (link/detections/alerts) มาจาก API ของเซิร์ฟเวอร์ —
  // ตัวจำลองฝั่ง client ถูกถอนทิ้ง; alerts ถูก fetch เฉพาะ role ที่มีวิวนั้น
  const { now, link, detections, detApi, alerts, alertsApi, sysEvents, ackAlert, toggleOutage } =
    useMonitorEngine({ enabled: Boolean(session), hasAlerts: has('alerts') })

  // Alerts เป็นวิวของ SOC-Responder เท่านั้น — operator ไม่มีแม้แต่ badge/กระดิ่ง
  const unacked = has('alerts') ? alerts.filter((a) => !a.acked).length : 0

  // ปุ่ม L (demo link outage) เป็นของ SOC-Responder เท่านั้น — POST /api/link/outage
  // บังคับ requireRole(SOC) ฝั่งเซิร์ฟเวอร์อยู่แล้ว (นั่นคือ "การควบคุม") ค่านี้เป็นแค่
  // การแสดงผล: ไม่โฆษณาคีย์ลัดที่ role นี้กดแล้วได้ 403 เงียบ ๆ — เหมือนกระดิ่ง Alerts
  const canLinkTest = session?.role === 'SOC-Responder'

  // เซสชันหมดอายุกลางคัน (401 จาก endpoint ใด) → กลับประตูทันที ไม่ค้างจอ
  useEffect(() => {
    registerUnauthorizedHandler(() => {
      setSession(null)
      setCameras(null)
    })
  }, [])

  // ตรวจเซสชันเดิมตอนเปิดแอป — cookie (HttpOnly) แนบไปเอง
  useEffect(() => {
    let alive = true
    fetchMe().then((me) => {
      if (!alive) return
      if (me) setSession({ ...me.user, menu: me.menu })
      setAuthChecked(true)
    })
    return () => { alive = false }
  }, [])

  // หลังมีเซสชัน — ดึงรายการกล้องที่ตนมองเห็น (ขอบเขตมาจากเซิร์ฟเวอร์)
  useEffect(() => {
    if (!session) { setCameras(null); return }
    let alive = true
    fetchCameras().then((cams) => {
      if (!alive) return
      setCameras(cams)
      // hero เริ่มที่กล้องแรกที่มองเห็น (SOC เห็นทุกตัว → CAM-02 ตามซีนเดิม)
      if (cams?.length) {
        setHeroCam((h) => (h && cams.some((c) => c.id === h) ? h : (cams.find((c) => c.id === 'CAM-02')?.id ?? cams[0].id)))
      }
    })
    return () => { alive = false }
  }, [session])

  // ถ้าวิวปัจจุบันหลุดจากเมนู (เช่นเพิ่งล็อกอินเป็น role อื่น) — กลับวิวแรก
  useEffect(() => {
    if (!session) return
    if (!viewOrder.includes(view)) setView(viewOrder[0] ?? 'live')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, view, menu.length])

  useEffect(() => {
    if (!session) return
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const n = Number(e.key)
      if (n >= 1 && n <= viewOrder.length) setView(viewOrder[n - 1])
      else if (canLinkTest && (e.key === 'l' || e.key === 'L')) toggleOutage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleOutage, session, viewOrder, canLinkTest])

  useEffect(() => {
    document.title = (unacked ? `(${unacked}) ` : '') + 'AEGIS Monitor — AI CCTV HUD'
  }, [unacked])

  const signOut = () => {
    // ทำลายเซสชันฝั่งเซิร์ฟเวอร์ แล้วกลับสู่ประตูของ Monitor เอง
    // (ไม่ redirect ไปแอปอื่น — identity ของแต่ละแอปแยกขาดกัน)
    apiLogout()
    setSession(null)
    setCameras(null)
    setView('live')
  }

  // ยังตรวจเซสชันไม่เสร็จ — กันหน้า Login กระพริบ
  if (!authChecked) {
    return <div className="app" aria-busy="true" />
  }

  if (!session) {
    return (
      <Login
        theme={theme}
        setTheme={setTheme}
        lang={lang}
        setLang={setLang}
        onAuthed={({ user, menu: m }) => {
          setSession({ ...user, menu: m })
        }}
      />
    )
  }

  const visibleCams = cameras ?? []

  return (
    <>
      <a className="skiplink" href="#main">Skip to content</a>
      <div className="orb a" /><div className="orb b" /><div className="orb c" />
      <div className="app">
        <TopBar
          theme={theme}
          clockText={fmtTime(now)}
          dateText={fmtDate(now)}
          linkStatus={link.status}
          link={link}
          unacked={unacked}
          showBell={has('alerts')}
          onBell={() => setView('alerts')}
          user={session}
          onSignOut={signOut}
        />
        <MobileNav sections={sections} view={view} setView={setView} unacked={unacked} />
        <div className="body">
          <Sidebar sections={sections} view={view} setView={setView} unacked={unacked} viewCount={viewOrder.length} canLinkTest={canLinkTest} />
          <main id="main" className="main glass">
            <div className="viewfade" key={view}>
              {/* render เฉพาะวิวที่อยู่ในเมนูของเซิร์ฟเวอร์ — นอกเมนู = ไม่มีใน DOM */}
              {view === 'live' && has('live') && (
                <Live
                  now={now} link={link} detections={detections} sysEvents={sysEvents}
                  cameras={visibleCams}
                  heroCam={heroCam} setHeroCam={setHeroCam}
                />
              )}
              {view === 'archive' && has('archive') && (
                <Archive
                  now={now}
                  cameras={visibleCams}
                  arcCam={arcCam} setArcCam={setArcCam}
                  arcResult={arcResult} setArcResult={setArcResult}
                />
              )}
              {view === 'detection' && has('detection') && (
                <Detection
                  now={now} link={link} detections={detections} api={detApi}
                  cameras={visibleCams}
                  detCam={detCam} setDetCam={setDetCam}
                  detResult={detResult} setDetResult={setDetResult}
                />
              )}
              {view === 'alerts' && has('alerts') && (
                <Alerts alerts={alerts} ackAlert={ackAlert} api={alertsApi} />
              )}
              {view === 'nodes' && has('nodes') && <Nodes />}
              {view === 'operators' && has('operators') && <Operators />}
              {view === 'diagnostics' && has('diagnostics') && (
                <Diagnostics now={now} link={link} cameras={visibleCams} />
              )}
              {view === 'settings' && has('settings') && (
                <Settings
                  lang={lang} setLang={setLang}
                  theme={theme} setTheme={setTheme}
                  user={session} cameras={visibleCams} link={link}
                  onSignOut={signOut}
                />
              )}
            </div>
          </main>
        </div>
        <Footer linkStatus={link.status} />
      </div>
    </>
  )
}
