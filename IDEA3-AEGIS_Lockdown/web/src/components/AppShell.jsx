import React, { useEffect, useMemo, useState } from 'react'
import { LogOut, Menu, Moon, ShieldCheck, Sun, X } from 'lucide-react'
import { APP_ROUTES, routeById } from '../lib/routes.js'
import { DemoBanner } from './DemoBanner.jsx'

function AegisMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <ShieldCheck size={24} />
      <span /><span /><span />
    </div>
  )
}

export function AppShell({ identity, mode, currentRoute, onNavigate = () => {}, onLogout, theme = 'light', onThemeChange = () => {}, children }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [clock, setClock] = useState(new Date())
  const route = routeById(currentRoute)
  const grouped = useMemo(() => Object.groupBy(APP_ROUTES, (item) => item.group), [])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const navigate = (event, id) => {
    event.preventDefault()
    setDrawerOpen(false)
    onNavigate(id)
  }

  return (
    <div className="app-shell">
      <button className="mobile-menu" aria-label="เปิดเมนู" onClick={() => setDrawerOpen(true)}><Menu /></button>
      {drawerOpen && <button className="drawer-scrim" aria-label="ปิดเมนู" onClick={() => setDrawerOpen(false)} />}
      <aside className={`sidebar${drawerOpen ? ' sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <AegisMark />
          <div><strong>AEGIS Security</strong><span>ศูนย์หลักฐานและการตอบสนอง</span></div>
          <button className="sidebar__close" aria-label="ปิดเมนู" onClick={() => setDrawerOpen(false)}><X /></button>
        </div>
        <nav aria-label="เมนูหลัก">
          {Object.entries(grouped).map(([group, routes]) => (
            <div className="nav-group" key={group}>
              <p>{group}</p>
              {routes.map(({ id, label, icon: Icon }) => (
                <a key={id} href={`/security/${id}`} aria-current={currentRoute === id ? 'page' : undefined} onClick={(event) => navigate(event, id)}>
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar__state"><span className="pulse-dot" /><div><strong>{mode === 'DEMO' ? 'Demo evidence' : 'Live evidence'}</strong><span>Admin-only · Same origin</span></div></div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="source-chips"><span><i className="dot dot--good" />API: พร้อมใช้</span><span><i className={`dot ${mode === 'DEMO' ? 'dot--warn' : ''}`} />Mode: {mode}</span></div>
          <div className="topbar__right">
            <button className="icon-button" aria-label={theme === 'light' ? 'ใช้ธีมมืด' : 'ใช้ธีมสว่าง'} onClick={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}>
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <div className="clock"><strong>{clock.toLocaleTimeString('th-TH', { hour12: false })}</strong><span>{clock.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })}</span></div>
            <div className="identity"><span className="avatar">SA</span><div><strong>{identity.displayName}</strong><span>{identity.role}</span></div></div>
            {onLogout && <button className="icon-button" aria-label="ออกจากระบบ" onClick={onLogout}><LogOut size={17} /></button>}
          </div>
        </header>
        <DemoBanner mode={mode} />
        <main>
          <header className="page-heading">
            <p>AEGIS <span>/</span> {route.eyebrow}</p>
            <h1>{route.label}</h1>
          </header>
          {children}
        </main>
      </div>
    </div>
  )
}
