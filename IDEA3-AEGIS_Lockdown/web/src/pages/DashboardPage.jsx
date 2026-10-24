import React from 'react'
import {
  Activity, ArrowUpRight, BellRing, Network, Radar, RefreshCw, ShieldAlert, ShieldCheck,
} from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { MetricCard } from '../components/MetricCard.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { LevelTag } from '../components/GraduatedPanel.jsx'
import { graduatedOf } from '../lib/graduated.js'
import {
  dashboardIssues, evidenceStatus, isAcknowledgedIncident, recommendedActions, runtimeComponent,
} from '../lib/dashboard.js'
import { countsTrusted, domainView, evidenceAgeAt, evidenceCount, zeroAwareStatus } from '../lib/evidence.js'
import { formatDateTime, formatEvidenceAge } from '../lib/format.js'
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
  DISPATCH_PENDING: 'value.dispatchPending',
  DISPATCH_UNAVAILABLE: 'value.dispatchUnavailable',
  CORE_CLAIMED: 'value.coreClaimed',
  PUBLISHED: 'value.published',
  DRY_RUN_ONLY: 'value.dryRunOnly',
  ACK_RECEIVED: 'value.acked',
  STATUS_CORRELATED: 'value.statusCorrelated',
  OUTCOME_UNKNOWN: 'value.outcomeUnknown',
  EXPIRED: 'value.dispatchExpired',
  EXPIRED_AT_CORE: 'value.expiredAtCore',
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

function formatNumber(value, language) {
  return evidenceCount(value, true, language)
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
  if (!Number.isFinite(Date.parse(timestamp)) || !Number.isFinite(Date.parse(snapshotTimestamp))) return t('time.missing')
  return evidenceAgeAt(timestamp, snapshotTimestamp, language)
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
  if (!incident) return <div className="empty-state dashboard-empty" data-density="compact"><span className="aegis-hatch" aria-hidden="true" /><p>{t('incident.empty')}</p></div>

  const sources = [incident.idea1Count ? 'IDEA1' : null, incident.idea2Count ? 'IDEA2' : null].filter(Boolean).join(' + ') || statusLabel('UNKNOWN', language)
  const acknowledged = isAcknowledgedIncident(incident) ? t('value.acked') : t('value.notAcknowledged')
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
    count: formatNumber(issue.variables?.count, language),
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
  return t(action.actionKey, { ...action.actionVariables, component, count: formatNumber(action.variables?.count, language) })
}

export function DashboardPage({ snapshot, apiConnected = true, onNavigate, onRefresh, language = 'th' }) {
  const activeLanguage = normalizeLanguage(language)
  const t = makeT(activeLanguage)
  const incident = snapshot.incidents?.[0]
  const rawIssues = dashboardIssues(snapshot, { apiConnected })
  const priorities = recommendedActions(rawIssues).map((action) => ({
    ...localizedIssue(action, activeLanguage, t),
    actionLabel: localizedAction(action, activeLanguage, t),
  }))
  const idea1 = domainView(snapshot.idea1)
  const idea2 = domainView(snapshot.idea2)
  const runtimeStatus = evidenceStatus(snapshot.runtime)
  const device = snapshot.devices?.[0]
  const overall = snapshot.overall ?? {}
  const overallStatus = overall.status ?? 'UNKNOWN'
  const overallFreshness = (snapshot.sources ?? []).some((source) => source.freshness === 'STALE') ? 'STALE'
    : Number.isFinite(overall.evidenceAgeMs) ? overallStatus : 'UNKNOWN'
  const overallTrusted = countsTrusted(overallFreshness)
  const mqtt = runtimeComponent(snapshot.runtime, 'broker')
  const heartbeat = runtimeComponent(snapshot.runtime, 'heartbeat')
  const relay = runtimeComponent(snapshot.runtime, 'relay')
  const physicalRelay = device?.physicalRelayState && device.physicalRelayState !== 'UNKNOWN' ? device.physicalRelayState : 'NOT_VERIFIED'
  const metricCount = (value) => evidenceCount(value, overallTrusted, activeLanguage)
  const metricStatus = (value, positive) => zeroAwareStatus(value, overallTrusted, overallFreshness, positive)
  const metricCopy = (status) => ({ statusLabel: statusLabel(status, activeLanguage), statusAriaLabel: t('status.aria', { status: statusLabel(status, activeLanguage) }) })
  const countDetail = (value, fallback) => (Number.isFinite(value) && (value > 0 || overallTrusted) ? fallback : t('metric.countUnverified'))
  const domainCount = (view, value) => evidenceCount(value, view.trusted, activeLanguage)
  const incidentsStatus = metricStatus(overall.activeIncidents, 'DEGRADED')
  const graduated = graduatedOf(snapshot)
  const alertsStatus = metricStatus(overall.highAlerts, 'FAILED')

  return (
    <div className="page-stack dashboard-page">
      <section className="mission-control mission-control--compact" role="region" aria-label={t('dashboard.systemStatusAria')}>
        <header>
          <div>
            <p>{t('dashboard.kicker')}</p>
            <h2>{t('dashboard.title')}</h2>
          </div>
          <div className="mission-control__actions">
            {onRefresh && <button className="button button--secondary" type="button" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />{t('dashboard.refresh')}</button>}
          </div>
        </header>
        <div className="global-status-grid">
          <GlobalFact label={t('global.environment')} value={snapshot.mode} status={snapshot.mode === 'DEMO' ? 'DEGRADED' : undefined} detail={t(snapshot.mode === 'DEMO' ? 'global.environmentDemo' : 'global.environmentLive')} language={activeLanguage} t={t} />
          <GlobalFact label="API" value={statusLabel(apiConnected ? 'CONNECTED' : 'DISCONNECTED', activeLanguage)} status={apiConnected ? 'HEALTHY' : 'FAILED'} detail={apiConnected ? undefined : t('global.apiDisconnected')} language={activeLanguage} t={t} />
          <GlobalFact label={t('global.runtime')} value={statusLabel(runtimeStatus, activeLanguage)} status={runtimeStatus} detail={t('global.runtimeDetail')} language={activeLanguage} t={t} />
          <GlobalFact label={t('global.freshness')} value={formatEvidenceAge(overall.evidenceAgeMs, activeLanguage)} status={overallFreshness} language={activeLanguage} t={t} />
        </div>
      </section>

      <section className="metric-grid metric-grid--three" aria-label={t('dashboard.summaryAria')}>
        <MetricCard icon={Activity} label={t('metric.activeIncidents')} value={metricCount(overall.activeIncidents)} suffix={Number.isFinite(overall.activeIncidents) && (overall.activeIncidents > 0 || overallTrusted) ? t('count.itemUnit') : undefined} status={incidentsStatus} {...metricCopy(incidentsStatus)} detail={incident ? t('metric.latestIncident', { id: incident.id }) : countDetail(overall.activeIncidents, t('metric.noIncident'))} />
        <MetricCard icon={BellRing} label={t('metric.highAlerts')} value={metricCount(overall.highAlerts)} suffix={Number.isFinite(overall.highAlerts) && (overall.highAlerts > 0 || overallTrusted) ? t('count.itemUnit') : undefined} status={alertsStatus} {...metricCopy(alertsStatus)} detail={countDetail(overall.highAlerts, t('metric.highAlertsDetail'))} />
        <MetricCard
          icon={ShieldAlert}
          label={t('graduated.metricLabel')}
          value={graduated ? <LevelTag level={graduated.highestLevel} muted={!graduated.current} /> : t('graduated.notAvailable')}
          status={graduated ? (graduated.current ? undefined : 'STALE') : 'UNKNOWN'}
          {...(graduated ? {} : metricCopy('UNKNOWN'))}
          detail={graduated
            ? (graduated.current ? t('graduated.current') : t('graduated.historical', { age: formatEvidenceAge(graduated.ageMs, activeLanguage) }))
            : t('graduated.notAvailableDetail')}
        />
      </section>

      <section className="idea-status-grid" data-layout="content-height" aria-label={t('idea.statusAria')}>
        <IdeaCard testId="idea1-status-card" icon={ShieldCheck} title={t('idea1.title')} mode={t('idea1.mode')} status={idea1.status} route="idea1" onNavigate={onNavigate} language={activeLanguage} t={t}>
          <MiniFacts items={[
            [t('idea1.denied'), domainCount(idea1, idea1.summary.denied)],
            [t('idea1.blocked'), domainCount(idea1, idea1.summary.blocked)],
            [t('idea1.latest'), idea1.trusted ? formatDateTime(idea1.generatedAt, activeLanguage) : t('time.missing')],
          ]} />
        </IdeaCard>

        <IdeaCard testId="idea2-status-card" icon={Radar} title={t('idea2.title')} mode={t('idea2.mode')} status={idea2.status} route="idea2" onNavigate={onNavigate} language={activeLanguage} t={t}>
          <MiniFacts items={[
            [t('idea2.detections'), domainCount(idea2, idea2.summary.detections)],
            [t('idea2.highCritical'), `${domainCount(idea2, idea2.summary.high)} / ${domainCount(idea2, idea2.summary.critical)}`],
            [t('idea2.freshness'), ageAtSnapshot(idea2.generatedAt, snapshot.generatedAt, activeLanguage, t)],
          ]} />
        </IdeaCard>

        <IdeaCard testId="idea3-status-card" icon={Network} title={t('idea3.title')} mode={t('idea3.mode')} status={runtimeStatus} route="lockdown" onNavigate={onNavigate} language={activeLanguage} t={t}>
          <MiniFacts items={[
            ['MQTT', localizedValue(mqtt.status, activeLanguage, t)],
            [t('idea3.heartbeat'), localizedValue(heartbeat.status, activeLanguage, t)],
            [t('idea3.requested'), localizedValue(device?.requestedRelayState, activeLanguage, t)],
            [t('idea3.observedUplink'), localizedValue(device?.observedUplinkState, activeLanguage, t)],
            [t('idea3.physicalRelay'), localizedValue(physicalRelay, activeLanguage, t)],
          ]} />
          {relay.status === 'UNKNOWN' && <p className="not-verified-note">{t('idea3.relayUnknown')}</p>}
        </IdeaCard>
      </section>

      <section className="dashboard-operations">
        <Panel title={t('incident.title')}>
          <IncidentSpotlight incident={incident} snapshotTimestamp={snapshot.generatedAt} onNavigate={onNavigate} language={activeLanguage} t={t} />
        </Panel>
        <Panel title={t('attention.title')} description={t('action.description')} action={<RouteLink route="overview" onNavigate={onNavigate}>{t('dashboard.openOverview')}</RouteLink>}>
          {priorities.length ? <div className="dashboard-issue-list">{priorities.map((issue) => (
            <article key={issue.key} data-testid="attention-item">
              <StatusBadge status={issue.status} compact {...badgeCopy(issue.status, activeLanguage, t)} />
              <div><strong>{issue.title}</strong><p>{issue.detail}</p><small>{issue.actionLabel}</small></div>
              <RouteLink route={issue.route} onNavigate={onNavigate} ariaLabel={t('action.openAria', { action: issue.actionLabel })}><span className="sr-only">{t('idea.viewDetails')}</span></RouteLink>
            </article>
          ))}</div> : <div className="empty-state dashboard-empty"><span className="aegis-hatch" aria-hidden="true" /><p>{t('attention.empty')}</p></div>}
        </Panel>
      </section>

      <Panel className="dashboard-evidence-panel" title={t('event.title')} description={t('event.description')} action={<RouteLink route="alerts" onNavigate={onNavigate}>{t('event.openAlerts')}</RouteLink>}>
        <div className="dashboard-latest-evidence" data-density="compact">
          <DataTable columns={eventColumns(activeLanguage, t)} rows={(snapshot.events ?? []).slice(0, 6)} emptyLabel={t('event.empty')} />
        </div>
      </Panel>
    </div>
  )
}
