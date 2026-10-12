import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical, LogOut, Menu, Moon, Radio, ShieldCheck, Sun, X } from 'lucide-react'
import { htmlLanguage, LANGUAGE_OPTIONS, localeFor, makeT, normalizeLanguage } from '../lib/i18n.js'
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

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => Array.from(word)[0]).join('') : Array.from(words[0]).slice(0, 2).join('')
  return letters.toLocaleUpperCase()
}

export function AppShell({ identity, mode, currentRoute, onNavigate = () => {}, onLogout, theme = 'light', onThemeChange = () => {}, language = 'th', onLanguageChange = () => {}, children }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [clock, setClock] = useState(new Date())
  const menuButtonRef = useRef(null)
  const closeButtonRef = useRef(null)
  const mainRef = useRef(null)
  const route = routeById(currentRoute)
  const grouped = useMemo(() => Object.groupBy(APP_ROUTES, (item) => item.group), [])
  const dashboardRoute = currentRoute === 'dashboard'
  const activeLanguage = dashboardRoute ? normalizeLanguage(language) : 'th'
  const t = makeT(activeLanguage)
  const contentLanguage = htmlLanguage(activeLanguage)

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return undefined
    closeButtonRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      setDrawerOpen(false)
      menuButtonRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const closeDrawer = () => {
    setDrawerOpen(false)
    menuButtonRef.current?.focus()
  }

  const navigate = (event, id) => {
    event.preventDefault()
    setDrawerOpen(false)
    onNavigate(id)
  }

  const changeLanguageFromKeyboard = (event, index) => {
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1
      : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    if (!direction) return
    event.preventDefault()
    const nextIndex = (index + direction + LANGUAGE_OPTIONS.length) % LANGUAGE_OPTIONS.length
    const nextLanguage = LANGUAGE_OPTIONS[nextIndex].value
    onLanguageChange(nextLanguage)
    event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[nextIndex]?.focus()
  }

  return (
    <div className="app-shell">
      <button type="button" className="skip-link" lang="th" onClick={() => mainRef.current?.focus()}>ข้ามไปยังเนื้อหาหลัก</button>
      <button ref={menuButtonRef} type="button" className="mobile-menu" lang="th" aria-label="เปิดเมนู" aria-expanded={drawerOpen} aria-controls="app-sidebar" onClick={() => setDrawerOpen(true)}><Menu aria-hidden="true" /></button>
      {drawerOpen && <button type="button" className="drawer-scrim" aria-label="ปิดเมนู" tabIndex={-1} onClick={closeDrawer} />}
      <aside id="app-sidebar" lang="th" className={`sidebar${drawerOpen ? ' sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <AegisMark />
          <div><strong>AEGIS Security</strong><span>ศูนย์หลักฐานและการตอบสนอง</span></div>
          <button ref={closeButtonRef} type="button" className="sidebar__close" aria-label="ปิดเมนู" onClick={closeDrawer}><X aria-hidden="true" /></button>
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
        <div className={`sidebar__state${mode === 'DEMO' ? ' sidebar__state--demo' : ''}`}><span className={mode === 'DEMO' ? 'dot dot--warn' : 'pulse-dot'} aria-hidden="true" /><div><strong>{mode === 'DEMO' ? 'Demo evidence' : 'Live evidence'}</strong><span>Admin-only · Same origin</span></div></div>
      </aside>

      <div className="workspace">
        <header className={`topbar${dashboardRoute ? ' topbar--dashboard' : ''}`} lang={contentLanguage}>
          <div className="source-chips"><span><i className="dot dot--good" aria-hidden="true" />{dashboardRoute ? t('shell.apiReady') : 'API: พร้อมใช้'}</span><span className={mode === 'DEMO' ? 'source-chip--demo' : 'source-chip--live'} data-mode={mode}>{mode === 'DEMO' ? <FlaskConical size={12} aria-hidden="true" /> : <Radio size={12} aria-hidden="true" />}{dashboardRoute ? t('shell.mode', { mode }) : `Mode: ${mode}`}</span></div>
          <div className="topbar__right">
            {dashboardRoute && (
              <div className="language-segmented" role="radiogroup" aria-label={t('language.label')}>
                {LANGUAGE_OPTIONS.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={activeLanguage === option.value}
                    onClick={() => onLanguageChange(option.value)}
                    onKeyDown={(event) => changeLanguageFromKeyboard(event, index)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="icon-button" aria-label={dashboardRoute ? t(theme === 'light' ? 'theme.useDark' : 'theme.useLight') : theme === 'light' ? 'ใช้ธีมมืด' : 'ใช้ธีมสว่าง'} onClick={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}>
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <div className="clock"><strong>{clock.toLocaleTimeString(localeFor(activeLanguage), { hour12: false })}</strong><span>{clock.toLocaleDateString(localeFor(activeLanguage), { day: '2-digit', month: 'short', year: 'numeric' })}</span></div>
            <div className="identity"><span className="avatar" aria-hidden="true">{initialsOf(identity.displayName)}</span><div><strong>{identity.displayName}</strong><span>{identity.role}</span></div></div>
            {onLogout && <button type="button" className="icon-button" aria-label="ออกจากระบบ" onClick={onLogout}><LogOut size={17} aria-hidden="true" /></button>}
          </div>
        </header>
        <DemoBanner mode={mode} language={activeLanguage} />
        <main id="main-content" ref={mainRef} tabIndex={-1} lang={contentLanguage}>
          <header className="page-heading">
            <p>AEGIS <span>/</span> {dashboardRoute ? t('shell.dashboardEyebrow') : route.eyebrow}</p>
            <h1>{dashboardRoute ? t('shell.dashboardTitle') : route.label}</h1>
            {!dashboardRoute && route.description && (
              <p className="page-heading__description">{route.description}</p>
            )}
          </header>
          {children}
        </main>
      </div>
    </div>
  )
}
