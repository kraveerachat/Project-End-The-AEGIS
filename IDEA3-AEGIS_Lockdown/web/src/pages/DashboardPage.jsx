import React from 'react'
import {
  Activity, ArrowUpRight, BellRing, Database, Network, Radar,
  RefreshCw, ShieldAlert, ShieldCheck,
} from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import {
  activeRuntimeModes, dashboardIssues, engineState, engineStatus, evidenceStatus,
  recommendedActions, runtimeComponent,
} from '../lib/dashboard.js'
import { formatCount, formatDateTime, formatEvidenceAge } from '../lib/format.js'
import { makeT, normalizeLanguage, statusLabel } from '../lib/i18n.js'

const statusValues = new Set([
  'HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'NOT_CONFIGURED', 'STALE',
  'DISABLED', 'CONNECTED', 'DISCONNECTED', 'NOT_VERIFIED',
])

const valueKeys = Object.freeze({
  OPEN: 'value.open',
  CLOSED: 'value.closed',
  AVAILABLE: 'value.available',
  INVESTIGATING: 'value.investigating',
  ACKED: 'value.acked',
  ACKNOWLEDGED: 'value.acked',
  NOT_ACKNOWLEDGED: 'value.notAcknowledged',
  RUNNING: 'value.running',
  STOPPED: 'value.stopped',
})

const runtimeModeKeys = Object.freeze({
  MONITOR_ONLY: 'runtime.monitorOnly',
  DRY_RUN: 'runtime.dryRun',
  ARMED: 'runtime.armed',
  AUTO_CONTAIN: 'runtime.autoContain',
  RECOVERY_AUTHORIZED: 'runtime.recoveryAuthorized',
})

const severityKeys = Object.freeze({
  INFO: 'severity.info',
  WARNING: 'severity.warning',
  HIGH: 'severity.high',
  CRITICAL: 'severity.critical',
})

const resultKeys = Object.freeze({
  DETECTED: 'result.detected',
  DENIED: 'result.denied',
  BLOCKED: 'result.blocked',
  VERIFIED: 'result.verified',
})

function RouteLink({ route, onNavigate, children, ariaLabel, className = 'dashboard-link' }) {
  return (
    <a
      className={className}
      href={`/security/${route}`}
      aria-label={ariaLabel}
      onClick={(event) => {
        if (!onNavigate) return
        event.preventDefault()
        onNavigate(route)
      }}
    >
      <span>{children}</span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  )
}

function localizedValue(value, language, t) {
  const normalizedValue = String(value || 'UNKNOWN').replaceAll(' ', '_')
  if (statusValues.has(normalizedValue)) return statusLabel(normalizedValue, language)
  if (valueKeys[normalizedValue]) return t(valueKeys[normalizedValue])
  return value || t('value.unavailable')
}

function badgeCopy(status, language, t) {
  const label = statusLabel(status, language)
  return { label, ariaLabel: t('status.aria', { status: label }) }
}

function ageAtSnapshot(timestamp, snapshotTimestamp, language, t) {
  const evidenceTime = Date.parse(timestamp)
  const snapshotTime = Date.parse(snapshotTimestamp)
  if (!Number.isFinite(evidenceTime) || !Number.isFinite(snapshotTime)) return t('time.missing')
  return formatEvidenceAge(Math.max(0, snapshotTime - evidenceTime), language)
}

function SourceHealthTable({ snapshot, language, t }) {
  const rows = snapshot.sources.map((source) => ({
    ...source,
    displayStatus: evidenceStatus(source),
    age: ageAtSnapshot(source.generatedAt, snapshot.generatedAt, language, t),
  }))
  const columns = [
    { key: 'name', label: t('source.columnSource'), render: (value, row) => <div className="primary-cell"><span className={`source-glyph source-glyph--${row.displayStatus.toLowerCase()}`} /><strong>{value}</strong></div> },
    { key: 'displayStatus', label: t('source.columnStatus'), render: (value) => <StatusBadge status={value} compact {...badgeCopy(value, language, t)} /> },
    { key: 'detail', label: t('source.columnContract') },
    { key: 'generatedAt', label: t('source.columnLastEvidence'), render: (value) => <span className="mono">{formatDateTime(value, language)}</span> },
    {
      key: 'age', label: t('source.columnFreshness'), render: (value, row) => (
        <span className={row.displayStatus === 'STALE' ? 'freshness freshness--stale' : 'freshness'}>
          {row.displayStatus === 'STALE' ? t('source.staleValue', { status: statusLabel('STALE', language), age: value }) : value}
        </span>
      ),
    },
    { key: 'latencyMs', label: t('source.columnLatency'), render: (value) => <span className="mono">{Number.isFinite(value) ? `${value.toFixed(1)} ms` : t('value.unavailable')}</span> },
  ]

  return <DataTable columns={columns} rows={rows} emptyLabel={t('source.empty')} />
}

function eventColumns(language, t) {
  return [
    { key: 'timestamp', label: t('event.columnTime'), render: (value) => <span className="mono">{formatDateTime(value, language)}</span> },
    { key: 'source', label: t('event.columnSource'), render: (value) => <span className="source-tag">{value}</span> },
    { key: 'type', label: t('event.columnType'), render: (value) => <strong className="table-strong">{value}</strong> },
    { key: 'sourceIp', label: t('event.columnSourceIp'), render: (value) => <span className="mono">{value || '—'}</span> },
    { key: 'severity', label: t('event.columnSeverity'), render: (value = 'INFO') => <span className={`severity severity--${value.toLowerCase()}`}>{t(severityKeys[value] || severityKeys.INFO)}</span> },
    { key: 'result', label: t('event.columnResult'), render: (value) => resultKeys[value] ? t(resultKeys[value]) : value || '—' },
  ]
}

function GlobalFact({ label, value, status, detail, language, t }) {
  return (
    <div className="global-fact">
      <div><span>{label}</span>{status && <StatusBadge status={status} compact {...badgeCopy(status, language, t)} />}</div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function IdeaCard({ testId, icon: Icon, title, mode, status, children, route, onNavigate, language, t }) {
  const ideaLabel = route === 'idea1' ? 'IDEA1' : route === 'idea2' ? 'IDEA2' : 'IDEA3'
  return (
    <article className="idea-status-card" data-testid={testId}>
      <header>
        <span className="idea-status-card__icon"><Icon size={19} aria-hidden="true" /></span>
        <div><h2>{title}</h2><p>{mode}</p></div>
        <StatusBadge status={status} compact {...badgeCopy(status, language, t)} />
      </header>
      <div className="idea-status-card__body">{children}</div>
      <RouteLink route={route} onNavigate={onNavigate} ariaLabel={t('idea.viewDetailsAria', { idea: ideaLabel })}>{t('idea.viewDetails')}</RouteLink>
    </article>
  )
}

function MiniFacts({ items }) {
  return <dl className="mini-facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function IncidentSpotlight({ incident, snapshotTimestamp, onNavigate, language, t }) {
  if (!incident) return <div className="empty-state dashboard-empty"><span className="aegis-hatch" aria-hidden="true" /><p>{t('incident.empty')}</p></div>

  const sources = [incident.idea1Count ? 'IDEA1' : null, incident.idea2Count ? 'IDEA2' : null].filter(Boolean).join(' + ') || statusLabel('UNKNOWN', language)
  const acknowledged = String(incident.responseState).includes('ACK') ? t('value.acked') : t('value.notAcknowledged')
  const severity = incident.severity || 'INFO'
  return (
    <article className="incident-focus">
      <div className="incident-focus__top">
        <span className="mono">{incident.id}</span>
        <span className={`severity severity--${severity.toLowerCase()}`}>{t(severityKeys[severity] || severityKeys.INFO)}</span>
      </div>
      <h3>{incident.title}</h3>
      <p>{incident.summary}</p>
      <MiniFacts items={[
        [t('incident.sourceIp'), incident.sourceIp || t('value.unavailable')],
        [t('incident.linkedSources'), sources],
        [t('incident.state'), localizedValue(incident.state, language, t)],
        [t('incident.responseState'), localizedValue(incident.responseState, language, t)],
        [t('incident.started'), formatDateTime(incident.firstSeen, language)],
        [t('incident.age'), ageAtSnapshot(incident.firstSeen, snapshotTimestamp, language, t)],
        [t('incident.acknowledgement'), acknowledged],
      ]} />
      <RouteLink route="incidents" onNavigate={onNavigate} ariaLabel={t('incident.openAria', { id: incident.id })} className="button button--primary dashboard-primary-action">{t('incident.open')}</RouteLink>
    </article>
  )
}

function localizedIssue(issue, language, t) {
  const component = issue.componentKey ? t(issue.componentKey) : issue.component
  const variables = {
    ...issue.variables,
    component,
    count: formatCount(issue.variables?.count, language),
  }
  return {
    ...issue,
    component,
    title: t(issue.messageKey, variables),
    detail: t(issue.detailKey, variables),
  }
}

function localizedAction(action, language, t) {
  const component = action.componentKey ? t(action.componentKey) : action.component
  return t(action.actionKey, { ...action.actionVariables, component, count: formatCount(action.variables?.count, language) })
}

export function DashboardPage({ snapshot, apiConnected = true, onNavigate, onRefresh, language = 'th' }) {
  const activeLanguage = normalizeLanguage(language)
  const t = makeT(activeLanguage)
  const incident = snapshot.incidents?.[0]
  const rawIssues = dashboardIssues(snapshot, { apiConnected })
  const issues = rawIssues.map((issue) => localizedIssue(issue, activeLanguage, t))
  const nextActions = recommendedActions(rawIssues)
  const idea1Status = evidenceStatus(snapshot.idea1)
  const idea2Status = evidenceStatus(snapshot.idea2)
  const runtimeStatus = evidenceStatus(snapshot.runtime)
  const runtimeModes = activeRuntimeModes(snapshot.runtime)
  const device = snapshot.devices?.[0]
  const correlation = engineState(snapshot.runtime?.engines?.correlation)
  const incidentEngine = engineState(snapshot.runtime?.engines?.incident)
  const overallFreshness = snapshot.sources.some((source) => source.freshness === 'STALE') ? 'STALE'
    : Number.isFinite(snapshot.overall.evidenceAgeMs) ? snapshot.overall.status : 'UNKNOWN'
  const supervisor = runtimeComponent(snapshot.runtime, 'runtime')
  const mqtt = runtimeComponent(snapshot.runtime, 'broker')
  const heartbeat = runtimeComponent(snapshot.runtime, 'heartbeat')
  const ack = runtimeComponent(snapshot.runtime, 'ack')
  const relay = runtimeComponent(snapshot.runtime, 'relay')
  const physicalRelay = device?.physicalRelayState && device.physicalRelayState !== 'UNKNOWN' ? device.physicalRelayState : 'NOT_VERIFIED'
  const overallLabel = statusLabel(snapshot.overall.status, activeLanguage)

  return (
    <div className="page-stack dashboard-page">
      <section className="mission-control" role="region" aria-label={t('dashboard.systemStatusAria')}>
        <header>
          <div>
            <p>{t('dashboard.kicker')}</p>
            <h2>{t('dashboard.title')}</h2>
            <span>{t('dashboard.summary')}</span>
          </div>
          <div className="mission-control__actions">
            <StatusBadge status={snapshot.overall.status} {...badgeCopy(snapshot.overall.status, activeLanguage, t)} />
            {onRefresh && <button className="button button--secondary" type="button" onClick={onRefresh}><RefreshCw size={15} />{t('dashboard.refresh')}</button>}
          </div>
        </header>
        <div className="global-status-grid">
          <GlobalFact label={t('global.environment')} value={snapshot.mode} status={snapshot.mode === 'DEMO' ? 'DEGRADED' : 'HEALTHY'} detail={t(snapshot.mode === 'DEMO' ? 'global.environmentDemo' : 'global.environmentLive')} language={activeLanguage} t={t} />
          <GlobalFact label="API" value={statusLabel(apiConnected ? 'CONNECTED' : 'DISCONNECTED', activeLanguage)} status={apiConnected ? 'HEALTHY' : 'FAILED'} detail={apiConnected ? undefined : t('global.apiDisconnected')} language={activeLanguage} t={t} />
          <GlobalFact label={t('global.freshness')} value={formatEvidenceAge(snapshot.overall.evidenceAgeMs, activeLanguage)} status={overallFreshness} language={activeLanguage} t={t} />
          <GlobalFact label={t('global.correlation')} value={localizedValue(correlation, activeLanguage, t)} status={engineStatus(correlation)} detail={correlation === 'UNKNOWN' ? t('global.engineUnknown') : undefined} language={activeLanguage} t={t} />
          <GlobalFact label={t('global.incidentEngine')} value={localizedValue(incidentEngine, activeLanguage, t)} status={engineStatus(incidentEngine)} detail={incidentEngine === 'UNKNOWN' ? t('global.engineUnknown') : undefined} language={activeLanguage} t={t} />
          <GlobalFact label={t('global.lastUpdate')} value={formatDateTime(snapshot.generatedAt, activeLanguage)} language={activeLanguage} t={t} />
        </div>
      </section>

      <section className="metric-grid metric-grid--four" aria-label={t('dashboard.summaryAria')}>
        <MetricCard icon={ShieldAlert} label={t('metric.overall')} value={overallLabel} status={snapshot.overall.status} statusLabel={overallLabel} statusAriaLabel={t('status.aria', { status: overallLabel })} />
        <MetricCard icon={Activity} label={t('metric.activeIncidents')} value={formatCount(snapshot.overall.activeIncidents, activeLanguage)} suffix={t('count.itemUnit')} status={snapshot.overall.activeIncidents ? 'DEGRADED' : 'HEALTHY'} statusLabel={statusLabel(snapshot.overall.activeIncidents ? 'DEGRADED' : 'HEALTHY', activeLanguage)} statusAriaLabel={t('status.aria', { status: statusLabel(snapshot.overall.activeIncidents ? 'DEGRADED' : 'HEALTHY', activeLanguage) })} detail={incident ? t('metric.latestIncident', { id: incident.id }) : t('metric.noIncident')} />
        <MetricCard icon={BellRing} label={t('metric.highAlerts')} value={formatCount(snapshot.overall.highAlerts, activeLanguage)} suffix={t('count.itemUnit')} status={snapshot.overall.highAlerts ? 'FAILED' : 'HEALTHY'} statusLabel={statusLabel(snapshot.overall.highAlerts ? 'FAILED' : 'HEALTHY', activeLanguage)} statusAriaLabel={t('status.aria', { status: statusLabel(snapshot.overall.highAlerts ? 'FAILED' : 'HEALTHY', activeLanguage) })} detail={t('metric.highAlertsDetail')} />
        <MetricCard icon={Database} label={t('metric.dailyEvidence')} value={formatCount(snapshot.overall.eventCount, activeLanguage)} status={overallFreshness} statusLabel={statusLabel(overallFreshness, activeLanguage)} statusAriaLabel={t('status.aria', { status: statusLabel(overallFreshness, activeLanguage) })} detail={formatEvidenceAge(snapshot.overall.evidenceAgeMs, activeLanguage)} />
      </section>

      <section className="idea-status-grid" aria-label={t('idea.statusAria')}>
        <IdeaCard testId="idea1-status-card" icon={ShieldCheck} title={t('idea1.title')} mode={t('idea1.mode')} status={idea1Status} route="idea1" onNavigate={onNavigate} language={activeLanguage} t={t}>
          <MiniFacts items={[
            [t('idea1.denied'), formatCount(snapshot.idea1.summary.denied, activeLanguage)],
            [t('idea1.blocked'), formatCount(snapshot.idea1.summary.blocked, activeLanguage)],
            [t('idea1.repeatedIp'), formatCount(snapshot.idea1.summary.repeated, activeLanguage)],
            [t('idea1.latest'), formatDateTime(snapshot.idea1.generatedAt, activeLanguage)],
            [t('idea1.freshness'), ageAtSnapshot(snapshot.idea1.generatedAt, snapshot.generatedAt, activeLanguage, t)],
          ]} />
        </IdeaCard>

        <IdeaCard testId="idea2-status-card" icon={Radar} title={t('idea2.title')} mode={t('idea2.mode')} status={idea2Status} route="idea2" onNavigate={onNavigate} language={activeLanguage} t={t}>
          <MiniFacts items={[
            [t('idea2.detections'), formatCount(snapshot.idea2.summary.detections, activeLanguage)],
            [t('idea2.highCritical'), `${formatCount(snapshot.idea2.summary.high, activeLanguage)} / ${formatCount(snapshot.idea2.summary.critical, activeLanguage)}`],
            [t('idea2.cameras'), formatCount(snapshot.idea2.summary.cameras, activeLanguage)],
            [t('idea2.latest'), formatDateTime(snapshot.idea2.generatedAt, activeLanguage)],
            [t('idea2.freshness'), ageAtSnapshot(snapshot.idea2.generatedAt, snapshot.generatedAt, activeLanguage, t)],
          ]} />
        </IdeaCard>

        <IdeaCard testId="idea3-status-card" icon={Network} title={t('idea3.title')} mode={t('idea3.mode')} status={runtimeStatus} route="lockdown" onNavigate={onNavigate} language={activeLanguage} t={t}>
          <div className="mode-row" aria-label={t('idea3.runtimeModeAria')}>{runtimeModes.length ? runtimeModes.map((mode) => <span key={mode}>{t(runtimeModeKeys[mode])}</span>) : <span>{statusLabel('UNKNOWN', activeLanguage)}</span>}</div>
          <MiniFacts items={[
            [t('idea3.supervisor'), localizedValue(supervisor.status, activeLanguage, t)],
            ['MQTT', localizedValue(mqtt.status, activeLanguage, t)],
            [t('idea3.heartbeat'), localizedValue(heartbeat.status, activeLanguage, t)],
            ['ACK', localizedValue(ack.status, activeLanguage, t)],
            [t('idea3.requested'), localizedValue(device?.requestedRelayState, activeLanguage, t)],
            [t('idea3.physicalRelay'), localizedValue(physicalRelay, activeLanguage, t)],
            [t('idea3.hardware'), localizedValue(snapshot.recovery?.liveHardware ? 'AVAILABLE' : 'DISABLED', activeLanguage, t)],
            [t('idea3.lastUpdate'), formatDateTime(snapshot.runtime.generatedAt, activeLanguage)],
          ]} />
          {relay.status === 'UNKNOWN' && <p className="not-verified-note">{t('idea3.relayUnknown')}</p>}
        </IdeaCard>
      </section>

      <section className="dashboard-operations">
        <Panel title={t('incident.title')}>
          <IncidentSpotlight incident={incident} snapshotTimestamp={snapshot.generatedAt} onNavigate={onNavigate} language={activeLanguage} t={t} />
        </Panel>
        <Panel title={t('attention.title')}>
          {issues.length ? <div className="dashboard-issue-list">{issues.map((issue) => (
            <article key={issue.key} data-testid="attention-item">
              <StatusBadge status={issue.status} compact {...badgeCopy(issue.status, activeLanguage, t)} />
              <div><strong>{issue.title}</strong><p>{issue.detail}</p><small>{issue.component}</small></div>
              <RouteLink route={issue.route} onNavigate={onNavigate} ariaLabel={t('attention.inspectAria', { component: issue.component })}><span className="sr-only">{t('idea.viewDetails')}</span></RouteLink>
            </article>
          ))}</div> : <div className="empty-state dashboard-empty"><span className="aegis-hatch" aria-hidden="true" /><p>{t('attention.empty')}</p></div>}
        </Panel>
      </section>

      <Panel title={t('source.title')} description={t('source.safetyNote')} action={<RouteLink route="settings" onNavigate={onNavigate}>{t('source.reviewAdapters')}</RouteLink>}>
        <SourceHealthTable snapshot={snapshot} language={activeLanguage} t={t} />
      </Panel>

      <section className="dashboard-operations dashboard-operations--evidence">
        <Panel title={t('event.title')} description={t('event.description')} action={<RouteLink route="alerts" onNavigate={onNavigate}>{t('event.openAlerts')}</RouteLink>}>
          <DataTable columns={eventColumns(activeLanguage, t)} rows={snapshot.events.slice(0, 6)} emptyLabel={t('event.empty')} />
        </Panel>
        <Panel title={t('action.title')} description={t('action.description')}>
          {nextActions.length ? <ol className="next-action-list">{nextActions.map((action, index) => {
            const actionLabel = localizedAction(action, activeLanguage, t)
            const component = action.componentKey ? t(action.componentKey) : action.component
            return (
              <li key={action.key}>
                <span>{index + 1}</span>
                <div><strong>{actionLabel}</strong><p>{t(action.messageKey, { ...action.variables, component })}</p></div>
                <RouteLink route={action.route} onNavigate={onNavigate} ariaLabel={t('action.openAria', { action: actionLabel })}><span className="sr-only">{t('idea.viewDetails')}</span></RouteLink>
              </li>
            )
          })}</ol> : <div className="empty-state dashboard-empty"><p>{t('action.empty')}</p></div>}
        </Panel>
      </section>
    </div>
  )
}
