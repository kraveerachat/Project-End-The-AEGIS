import React, { useCallback, useEffect, useState } from 'react'
import { AppShell } from './components/AppShell.jsx'
import { EvidenceState } from './components/EvidenceState.jsx'
import { apiFetch, setCsrfToken } from './lib/api.js'
import { htmlLanguage, normalizeLanguage } from './lib/i18n.js'
import { routeFromPath } from './lib/routes.js'
import { LoginPage } from './pages/LoginPage.jsx'
import { DashboardPage } from './pages/DashboardPage.jsx'
import { OverviewPage } from './pages/OverviewPage.jsx'
import { LockdownPage } from './pages/LockdownPage.jsx'
import { Idea1SecurityPage } from './pages/Idea1SecurityPage.jsx'
import { Idea2DetectionPage } from './pages/Idea2DetectionPage.jsx'
import { AlertsPage } from './pages/AlertsPage.jsx'
import { IncidentsPage } from './pages/IncidentsPage.jsx'
import { AuditPage } from './pages/AuditPage.jsx'
import { DevicesPage } from './pages/DevicesPage.jsx'
import { RecoveryPage } from './pages/RecoveryPage.jsx'
import { SettingsPage } from './pages/SettingsPage.jsx'

function renderPage(route, snapshot, actions, language) {
  if (route === 'dashboard') return <DashboardPage snapshot={snapshot} apiConnected={!actions.snapshotError} onNavigate={actions.navigate} onRefresh={actions.refresh} language={language} />
  if (route === 'overview') return <OverviewPage snapshot={snapshot} />
  if (route === 'idea1') return <Idea1SecurityPage snapshot={snapshot} />
  if (route === 'idea2') return <Idea2DetectionPage snapshot={snapshot} />
  if (route === 'lockdown') return <LockdownPage snapshot={snapshot} />
  if (route === 'alerts') return <AlertsPage snapshot={snapshot} onAcknowledge={actions.acknowledgeAlert} />
  if (route === 'incidents') return <IncidentsPage snapshot={snapshot} onAddNote={actions.addIncidentNote} />
  if (route === 'audit') return <AuditPage snapshot={snapshot} onExport={actions.exportAudit} />
  if (route === 'devices') return <DevicesPage snapshot={snapshot} />
  if (route === 'recovery') return <RecoveryPage snapshot={snapshot} onDryRun={actions.runRecoveryDryRun} />
  if (route === 'settings') return <SettingsPage snapshot={snapshot} onDemoMode={actions.setDemoMode} onSavePolicy={actions.savePolicy} />
  return <section className="panel"><div className="panel__body"><p>กำลังเตรียมข้อมูลสำหรับหน้า {route}</p></div></section>
}

function initialLanguage() {
  try {
    return normalizeLanguage(localStorage.getItem('aegis_lang'))
  } catch {
    return 'th'
  }
}

export default function App() {
  const [session, setSession] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [route, setRoute] = useState(() => routeFromPath())
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light')
  const [language, setLanguage] = useState(initialLanguage)
  const [error, setError] = useState('')

  const loadSnapshot = useCallback(async () => {
    try {
      setError('')
      setSnapshot(await apiFetch('/security/snapshot'))
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [])

  useEffect(() => {
    apiFetch('/auth/session')
      .then(async (value) => {
        setSession(value)
        if (value.authenticated) {
          const csrf = await apiFetch('/auth/csrf')
          setCsrfToken(csrf.csrfToken)
          await loadSnapshot()
        }
      })
      .catch(() => setSession({ authenticated: false }))
  }, [loadSnapshot])

  useEffect(() => {
    const popState = () => setRoute(routeFromPath())
    window.addEventListener('popstate', popState)
    return () => window.removeEventListener('popstate', popState)
  }, [])

  useEffect(() => {
    const activeLanguage = session?.authenticated && route === 'dashboard' ? language : 'th'
    document.documentElement.lang = htmlLanguage(activeLanguage)
  }, [language, route, session?.authenticated])

  async function login(credentials) {
    const response = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(credentials) })
    setCsrfToken(response.csrfToken)
    setSession({ authenticated: true, identity: response.identity, demoMode: false })
    await loadSnapshot()
  }

  async function logout() {
    await apiFetch('/auth/logout', { method: 'POST' })
    setCsrfToken(null)
    setSession({ authenticated: false })
    setSnapshot(null)
  }

  function navigate(nextRoute) {
    window.history.pushState({}, '', `/security/${nextRoute}`)
    setRoute(nextRoute)
  }

  function changeTheme(nextTheme) {
    document.documentElement.dataset.theme = nextTheme
    localStorage.setItem('aegis-idea3-theme', nextTheme)
    setTheme(nextTheme)
  }

  function changeLanguage(nextLanguage) {
    const safeLanguage = normalizeLanguage(nextLanguage)
    try {
      localStorage.setItem('aegis_lang', safeLanguage)
    } catch {
      // Language still changes in memory when browser storage is unavailable.
    }
    setLanguage(safeLanguage)
  }

  async function performAction(path, options = {}) {
    try {
      setError('')
      await apiFetch(path, options)
      await loadSnapshot()
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const actions = {
    navigate,
    refresh: loadSnapshot,
    snapshotError: Boolean(error),
    acknowledgeAlert: (id) => performAction(`/security/alerts/${id}/acknowledge`, { method: 'POST', body: '{}' }),
    addIncidentNote: (id, note) => performAction(`/security/incidents/${id}/notes`, { method: 'POST', body: JSON.stringify({ note }) }),
    exportAudit: () => performAction('/security/audit/export', { method: 'POST', body: '{}' }),
    runRecoveryDryRun: (incidentId, confirmation) => performAction('/security/recovery/dry-run', { method: 'POST', body: JSON.stringify({ incidentId, confirmation }) }),
    setDemoMode: (enabled) => performAction('/security/demo-mode', { method: 'POST', body: JSON.stringify({ enabled }) }),
    savePolicy: (policy) => performAction('/security/settings', { method: 'PATCH', body: JSON.stringify(policy) }),
  }

  if (!session) return <div className="boot-screen"><span className="aegis-hatch" /><p>กำลังยืนยัน Security Center…</p></div>
  if (!session.authenticated) return <LoginPage onLogin={login} />

  const dashboardLanguage = route === 'dashboard' ? language : 'th'

  return (
    <AppShell identity={session.identity} mode={snapshot?.mode || 'LIVE'} currentRoute={route} onNavigate={navigate} onLogout={logout} theme={theme} onThemeChange={changeTheme} language={dashboardLanguage} onLanguageChange={changeLanguage}>
      <EvidenceState loading={!snapshot && !error} error={error} stale={Boolean(snapshot && error)} onRetry={loadSnapshot} language={route === 'dashboard' ? language : undefined}>
        {snapshot && renderPage(route, snapshot, actions, dashboardLanguage)}
      </EvidenceState>
    </AppShell>
  )
}
