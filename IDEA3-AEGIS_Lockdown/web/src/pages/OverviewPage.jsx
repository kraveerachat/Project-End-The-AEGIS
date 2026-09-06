import React from 'react'
import { ArrowRight, DatabaseZap, LockKeyhole, Radar, ServerCog, ShieldCheck } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatDateTime } from '../lib/format.js'

const CANONICAL_STATUSES = new Set([
  'HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN', 'NOT_CONFIGURED', 'STALE', 'DISABLED',
])

function safeStatus(value, fallback = 'UNKNOWN') {
  return CANONICAL_STATUSES.has(value) ? value : fallback
}

function safeText(value, fallback = 'UNKNOWN') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function evidenceStatus({ status, freshness, generatedAt }) {
  const normalized = safeStatus(status)
  if (freshness === 'STALE') return 'STALE'
  if (normalized === 'HEALTHY' && (freshness !== 'FRESH' || !generatedAt)) return 'UNKNOWN'
  return normalized
}

function sourceById(snapshot, id) {
  return snapshot.sources?.find((source) => source.id === id)
}

function adapterById(snapshot, id) {
  return snapshot.settings?.adapters?.find((adapter) => adapter.id === id)
}

function integrationStatus(source, domain) {
  if (!source) return 'NOT_CONFIGURED'
  return evidenceStatus({
    status: source.status,
    freshness: domain?.freshness ?? source.freshness,
    generatedAt: domain?.generatedAt ?? source.generatedAt,
  })
}

function securityReadiness(snapshot) {
  const security = snapshot.settings?.security
  const provenance = snapshot.provenance
  const integrationSources = ['idea1', 'idea2', 'idea3']
    .map((id) => ({
      id,
      source: sourceById(snapshot, id),
      domain: id === 'idea3' ? snapshot.runtime : snapshot[id],
    }))
    .filter(({ source }) => Boolean(source))
  const contractStates = integrationSources.map(({ source, domain }) => integrationStatus(source, domain))
  const contractStatus = integrationSources.length < 3
    ? 'NOT_CONFIGURED'
    : contractStates.includes('FAILED')
      ? 'FAILED'
      : contractStates.includes('STALE')
        ? 'STALE'
        : contractStates.includes('UNKNOWN') || contractStates.includes('NOT_CONFIGURED')
          ? 'UNKNOWN'
          : contractStates.includes('DEGRADED') ? 'DEGRADED' : 'HEALTHY'

  const adminStatus = !security
    ? 'NOT_CONFIGURED'
    : security.adminRbac === 'ENFORCED' && security.csrf === 'ENFORCED' ? 'HEALTHY' : 'DEGRADED'
  const isolationStatus = provenance?.liveMerged === false
    ? 'HEALTHY'
    : provenance?.liveMerged === true ? 'FAILED' : 'UNKNOWN'
  const persistence = safeText(provenance?.persistence, 'NOT_CONFIGURED')
  const storeStatus = persistence === 'NOT_CONFIGURED' || /MEMORY/.test(persistence) ? 'NOT_CONFIGURED' : 'UNKNOWN'

  return [
    { label: 'Durable production store', status: storeStatus, detail: persistence === 'NOT_CONFIGURED' ? 'ไม่มี persistence metadata' : `ปัจจุบัน: ${persistence}` },
    { label: 'Hardware control gateway', status: safeStatus(snapshot.recovery?.gatewayStatus, 'NOT_CONFIGURED'), detail: 'หน้าเว็บไม่มีสิทธิ์สั่ง Relay หรือ network isolation' },
    { label: 'Production deployment', status: safeStatus(snapshot.deployment?.status), detail: 'ไม่มี deployment evidence ใน snapshot นี้' },
    { label: 'Sanitized evidence contract', status: contractStatus, detail: `${integrationSources.length}/3 integration มีผล validation` },
    { label: 'Admin RBAC + CSRF', status: adminStatus, detail: adminStatus === 'HEALTHY' ? 'API ประกาศว่า ENFORCED' : 'ยังยืนยัน enforcement ไม่ครบ' },
    { label: 'Demo / Live isolation', status: isolationStatus, detail: isolationStatus === 'HEALTHY' ? 'provider ประกาศว่าไม่รวมข้อมูลข้าม boundary' : 'ยังยืนยันการแยก boundary ไม่ได้' },
  ]
}

const matrixColumns = [
  { key: 'name', label: 'Integration', render: (value) => <strong className="table-strong">{value}</strong> },
  { key: 'effectiveStatus', label: 'Overall', render: (value) => <StatusBadge status={value} compact /> },
  { key: 'freshness', label: 'Freshness', render: (value) => <span className={`freshness freshness--${safeText(value).toLowerCase()}`}>{safeText(value)}</span> },
  { key: 'generatedAt', label: 'Validated at', render: (value) => <span className="mono">{value ? formatDateTime(value) : 'ยังไม่ตรวจสอบ'}</span> },
  { key: 'detail', label: 'Contract / mode', render: (value) => safeText(value, 'ยังไม่มีผลการตรวจสอบ') },
  { key: 'sourceType', label: 'Source', render: (value) => <span className="mono">{value}</span> },
]

function FactList({ facts }) {
  return (
    <dl className="integration-facts">
      {facts.map(({ label, value, status }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{status ? <StatusBadge status={status} compact /> : <span className="mono">{value}</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

function ReadinessItem({ item }) {
  return (
    <div>
      <span className="readiness-ledger__copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
      <StatusBadge status={item.status} compact />
    </div>
  )
}

export function OverviewPage({ snapshot }) {
  const sources = {
    idea1: sourceById(snapshot, 'idea1'),
    idea2: sourceById(snapshot, 'idea2'),
    idea3: sourceById(snapshot, 'idea3'),
  }
  const adapters = {
    idea1: adapterById(snapshot, 'idea1'),
    idea2: adapterById(snapshot, 'idea2'),
    idea3: adapterById(snapshot, 'runtime') ?? adapterById(snapshot, 'idea3'),
  }
  const device = snapshot.devices?.[0]
  const runtimeModes = [
    snapshot.runtime?.modes?.monitorOnly && 'MONITOR ONLY',
    snapshot.runtime?.modes?.dryRun && 'DRY RUN',
  ].filter(Boolean)
  const domains = [
    {
      id: 'idea1', icon: ShieldCheck, eyebrow: 'IDEA1', title: 'Access Security',
      description: 'หลักฐาน access ที่ผ่าน sanitized adapter โดยไม่เปิดเผย payload ดิบ',
      status: integrationStatus(sources.idea1, snapshot.idea1),
      facts: [
        { label: 'Source', value: safeText(adapters.idea1?.alias, 'NOT_CONFIGURED') },
        { label: 'Contract', value: safeText(sources.idea1?.detail, 'ยังไม่มีผลการตรวจสอบ') },
        { label: 'Freshness', value: safeText(snapshot.idea1?.freshness, 'UNKNOWN') },
      ],
    },
    {
      id: 'idea2', icon: Radar, eyebrow: 'IDEA2', title: 'Detection Evidence',
      description: 'หลักฐาน detection แบบ privacy-preserving ที่ไม่มีภาพ วิดีโอ embedding หรือ PII',
      status: integrationStatus(sources.idea2, snapshot.idea2),
      facts: [
        { label: 'Source', value: safeText(adapters.idea2?.alias, 'NOT_CONFIGURED') },
        { label: 'Contract', value: safeText(sources.idea2?.detail, 'ยังไม่มีผลการตรวจสอบ') },
        { label: 'Freshness', value: safeText(snapshot.idea2?.freshness, 'UNKNOWN') },
      ],
    },
    {
      id: 'idea3', icon: ServerCog, eyebrow: 'IDEA3', title: 'Runtime',
      description: 'แยก runtime mode, ACK และหลักฐานทางกายภาพออกจากกันโดยไม่สรุปแทน Relay',
      status: integrationStatus(sources.idea3, snapshot.runtime),
      modes: runtimeModes.length ? runtimeModes : ['UNKNOWN'],
      facts: [
        { label: 'Source', value: safeText(adapters.idea3?.alias, 'NOT_CONFIGURED') },
        { label: 'Physical evidence', status: safeStatus(device?.physicalRelayState) },
        { label: 'Freshness', value: safeText(snapshot.runtime?.freshness, 'UNKNOWN') },
      ],
    },
  ]

  const matrixRows = ['idea1', 'idea2', 'idea3']
    .map((id) => {
      const source = sources[id]
      if (!source) return null
      const domain = id === 'idea3' ? snapshot.runtime : snapshot[id]
      return {
        ...source,
        effectiveStatus: integrationStatus(source, domain),
        freshness: domain?.freshness ?? source.freshness,
        generatedAt: domain?.generatedAt ?? source.generatedAt,
        sourceType: safeText(adapters[id]?.alias, 'NOT_CONFIGURED'),
      }
    })
    .filter(Boolean)
  const readiness = securityReadiness(snapshot)
  const readinessGaps = readiness.filter((item) => item.status !== 'HEALTHY')
  const readinessConfirmed = readiness.filter((item) => item.status === 'HEALTHY')
  const provider = safeText(snapshot.provenance?.provider)
  const persistence = safeText(snapshot.provenance?.persistence, 'NOT_CONFIGURED')
  const liveMerge = snapshot.provenance?.liveMerged === false
    ? 'NOT ALLOWED'
    : snapshot.provenance?.liveMerged === true ? 'ALLOWED' : 'UNKNOWN'

  return (
    <div className="page-stack overview-page">
      <section className="evidence-boundary" aria-label="ขอบเขตสภาพแวดล้อมและหลักฐาน">
        <h2 className="sr-only">ขอบเขตสภาพแวดล้อมและหลักฐาน</h2>
        <dl>
          <div><dt>Environment</dt><dd>{safeText(snapshot.mode)}</dd></div>
          <div><dt>Evidence provider</dt><dd>{provider}</dd></div>
          <div><dt>Persistence</dt><dd>{persistence}</dd></div>
          <div><dt>Live merge</dt><dd>{liveMerge}</dd></div>
        </dl>
      </section>

      <Panel className="evidence-flow-panel" title="เส้นทางของหลักฐาน" description="ข้อมูลจากแต่ละ IDEA ต้องผ่าน validation ก่อนเข้าสู่ Security Center" ariaLabel="เส้นทางของหลักฐาน">
        <div className="evidence-flow">
          <div className="flow-sources">
            <p>Upstream evidence</p>
            {domains.map(({ id, eyebrow, title, status }) => (
              <div className="flow-source" key={id}>
                <span><strong>{eyebrow}</strong>{` ${id === 'idea3' ? 'Runtime' : 'Evidence'}`}</span>
                <StatusBadge status={status} compact />
                <small>{title}</small>
              </div>
            ))}
          </div>
          <ArrowRight className="flow-arrow" aria-hidden="true" />
          <div className="flow-stage"><LockKeyhole aria-hidden="true" /><strong>Validate &amp; normalize</strong><span>Allowlist · schema · bounds</span></div>
          <ArrowRight className="flow-arrow" aria-hidden="true" />
          <div className="flow-stage"><DatabaseZap aria-hidden="true" /><strong>Store &amp; correlate</strong><span>Events แยกจาก Audit</span></div>
          <ArrowRight className="flow-arrow" aria-hidden="true" />
          <div className="flow-stage"><ShieldCheck aria-hidden="true" /><strong>Admin surface</strong><span>Session · RBAC · CSRF</span></div>
        </div>
      </Panel>

      <section className="integration-contracts" aria-label="สัญญาการเชื่อมต่อ">
        <header className="section-heading">
          <div><h2>สัญญาการเชื่อมต่อ</h2><p>สรุปแหล่งข้อมูล contract และ freshness ของแต่ละ integration</p></div>
        </header>
        <div className="integration-contract-grid">
          {domains.map(({ id, icon: Icon, eyebrow, title, description, status, modes, facts }) => (
            <article className="integration-card" aria-label={`${eyebrow} ${title} integration`} key={id}>
              <header>
                <span className="icon-box"><Icon size={19} aria-hidden="true" /></span>
                <div><p className="kicker">{eyebrow}</p><h3>{title}</h3></div>
                <StatusBadge status={status} compact />
              </header>
              <p>{description}</p>
              {modes && <div className="integration-modes" aria-label="Runtime mode">{modes.map((mode) => <span key={mode}>{mode}</span>)}</div>}
              <FactList facts={facts} />
            </article>
          ))}
        </div>
      </section>

      <Panel title="Integration matrix" description="ชั้นรายละเอียดทางเทคนิคจาก validation ล่าสุด" ariaLabel="Integration matrix">
        <DataTable columns={matrixColumns} rows={matrixRows} emptyLabel="ยังไม่มีผลการตรวจสอบ integration" />
      </Panel>

      <section className="overview-support-grid" aria-label="แหล่งข้อมูลและความพร้อมสำหรับ Production">
        <Panel title="แหล่งที่มาของข้อมูล" description="Safe metadata ที่ API ประกาศ">
          <dl className="provenance-list provenance-list--overview">
            <div><dt>Provider</dt><dd>{provider}</dd></div>
            <div><dt>Environment</dt><dd>{safeText(snapshot.mode)}</dd></div>
            <div><dt>Persistence</dt><dd>{persistence}</dd></div>
            <div><dt>Evidence boundary</dt><dd>{liveMerge === 'NOT ALLOWED' ? 'ISOLATED' : liveMerge}</dd></div>
            <div><dt>Live merge</dt><dd>{liveMerge === 'NOT ALLOWED' ? 'ไม่มีการรวม Demo กับ Live' : liveMerge}</dd></div>
          </dl>
        </Panel>

        <Panel title="ขอบเขตความพร้อม" description="ช่องว่างที่ต้องมีหลักฐานเพิ่มก่อนอ้างว่า Production-ready">
          <div className="readiness-groups">
            <section aria-labelledby="readiness-gaps-title">
              <h3 id="readiness-gaps-title">ช่องว่างก่อน Production</h3>
              <div className="readiness-ledger readiness-ledger--overview">
                {readinessGaps.map((item) => <ReadinessItem item={item} key={item.label} />)}
              </div>
            </section>
            <section aria-labelledby="readiness-confirmed-title">
              <h3 id="readiness-confirmed-title">ยืนยันจาก snapshot</h3>
              <div className="readiness-ledger readiness-ledger--overview">
                {readinessConfirmed.map((item) => <ReadinessItem item={item} key={item.label} />)}
              </div>
            </section>
          </div>
        </Panel>
      </section>
    </div>
  )
}
